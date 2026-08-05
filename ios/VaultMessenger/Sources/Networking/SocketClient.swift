import Foundation

/// Live updates over the server's websocket.
///
/// Authentication rides on the session cookie during the upgrade, the same as
/// the web client — there is no separate token to send.
///
/// Reconnects with exponential backoff. A phone changes network constantly
/// (backgrounded, cell to wifi, tunnel), so a socket that gives up after one
/// failure would leave the app looking permanently offline; and one that
/// retries in a tight loop would drain the battery and hammer the server.
@MainActor
final class SocketClient: ObservableObject {

    @Published private(set) var isConnected = false

    /// Incoming server events, already decoded to a type and payload.
    var onEvent: ((String, [String: Any]) -> Void)?

    private let url: URL
    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var reconnectAttempt = 0
    private var isStopped = true

    init(baseURL: URL, session: URLSession = .shared) {
        // http(s) → ws(s); the path is fixed by the server.
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.scheme = (baseURL.scheme == "https") ? "wss" : "ws"
        components?.path = "/ws"
        self.url = components?.url ?? baseURL
        self.session = session
    }

    func connect() {
        isStopped = false
        openSocket()
    }

    func disconnect() {
        // Set first: the receive handler checks it to decide whether a
        // closed socket is a failure worth retrying or an intentional stop.
        isStopped = true
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        isConnected = false
    }

    private func openSocket() {
        guard !isStopped else { return }

        let socket = session.webSocketTask(with: url)
        task = socket
        socket.resume()
        isConnected = true
        reconnectAttempt = 0
        listen()
    }

    private func listen() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    self.handle(message)
                    self.listen()
                case .failure:
                    self.isConnected = false
                    self.scheduleReconnect()
                }
            }
        }
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        let text: String?
        switch message {
        case .string(let s): text = s
        case .data(let d): text = String(data: d, encoding: .utf8)
        @unknown default: text = nil
        }

        guard
            let text,
            let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = object["type"] as? String
        else { return }

        // The server nests message payloads under `data`; everything else is
        // flat. Flattening here keeps that shape out of the view layer.
        let payload = (object["data"] as? [String: Any]) ?? object
        onEvent?(type, payload)
    }

    private func scheduleReconnect() {
        guard !isStopped else { return }

        reconnectAttempt += 1
        // 1, 2, 4 … capped at 30s. Capped because an unbounded backoff means
        // an app that was briefly offline stays silent for minutes after the
        // network returns, which reads as broken.
        let delay = min(pow(2.0, Double(reconnectAttempt - 1)), 30.0)

        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            self?.openSocket()
        }
    }
}
