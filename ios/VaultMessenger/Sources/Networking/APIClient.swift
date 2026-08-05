import Foundation

/// REST client for the Vault server.
///
/// Authentication is a `httpOnly` session cookie, exactly as on the web, so
/// there is no token for this app to store or leak — `URLSession`'s cookie
/// storage holds it and the app never sees it. That is also why every request
/// goes through one shared session: a second session would have its own
/// cookie jar and would appear signed out.
actor APIClient {

    enum Failure: Error, LocalizedError {
        case badURL
        case unauthorized
        case server(status: Int, message: String?)
        case decoding(String)

        var errorDescription: String? {
            switch self {
            case .badURL:
                return "That server address is not valid."
            case .unauthorized:
                return "Your session has expired. Sign in again."
            case .server(let status, let message):
                return message ?? "The server returned an error (\(status))."
            case .decoding(let what):
                return "The server sent something unexpected (\(what))."
            }
        }
    }

    private let baseURL: URL
    private let session: URLSession

    /// Parsed by hand rather than with a captured formatter: DateFormatter
    /// is not Sendable, and holding one inside the decoding closure makes the
    /// decoder unusable from an actor under Swift 6 concurrency.
    private static func parseTimestamp(_ raw: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: raw) { return date }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: raw)
    }

    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // Timestamps arrive as ISO-8601 with fractional seconds. Without the
        // fractional option every date silently fails to decode, which
        // surfaces as an empty chat list rather than as an error.
        d.dateDecodingStrategy = .custom { decoder in
            let raw = try decoder.singleValueContainer().decode(String.self)
            if let date = APIClient.parseTimestamp(raw) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Unrecognised date: \(raw)")
            )
        }
        return d
    }()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    // MARK: - Auth

    /// Per-account salt, fetched before deriving the login credential.
    ///
    /// This answers for accounts that do not exist too, so it cannot be used
    /// to find out who is registered — do not "helpfully" surface a
    /// not-found here.
    func salt(for username: String) async throws -> String {
        let escaped = username.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed) ?? username
        let response: SaltResponse = try await get("/api/auth/salt/\(escaped)")
        return response.salt
    }

    func logIn(username: String, password: String) async throws -> CurrentUser {
        let saltValue = try await salt(for: username)

        // 600k PBKDF2 rounds: deliberately off the main thread.
        let credential = try await Task.detached(priority: .userInitiated) {
            try KeyDerivation.loginCredential(password: password, saltBase64: saltValue)
        }.value

        return try await post("/api/auth/login", body: [
            "username": username,
            "password": credential,
            "deviceName": Self.deviceLabel,
            "platform": "iOS",
            "appVersion": "ios-1.0",
        ])
    }

    func currentUser() async throws -> CurrentUser {
        try await get("/api/auth/me")
    }

    func logOut() async throws {
        _ = try? await postRaw("/api/auth/logout", body: [:])
    }

    // MARK: - Chats

    func chats() async throws -> [Chat] {
        let response: ChatListResponse = try await get("/api/chats")
        return response.chats
    }

    func messages(chatId: String, limit: Int = 50) async throws -> MessagesResponse {
        try await get("/api/chats/\(chatId)/messages?limit=\(limit)")
    }

    func send(chatId: String, body: String) async throws -> SentMessage {
        try await post("/api/chats/\(chatId)/messages", body: [
            "type": "text",
            "body": body,
            // Lets a retried send resolve to the original message instead of
            // a duplicate, which matters more on a phone than on a desktop.
            "clientRandomId": Int.random(in: 1...Int(Int32.max)),
        ])
    }

    func markRead(chatId: String, upTo seq: Int) async throws {
        _ = try? await postRaw("/api/chats/\(chatId)/read", body: ["maxSeq": seq])
    }

    // MARK: - Plumbing

    private static var deviceLabel: String {
        #if targetEnvironment(simulator)
        return "iOS Simulator"
        #else
        return "iPhone"
        #endif
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try decode(try await perform(request(path, method: "GET")), path: path)
    }

    private func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try decode(try await postRaw(path, body: body), path: path)
    }

    @discardableResult
    private func postRaw(_ path: String, body: [String: Any]) async throws -> Data {
        var req = try request(path, method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await perform(req)
    }

    private func request(_ path: String, method: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL) else { throw Failure.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.httpShouldHandleCookies = true
        return req
    }

    private func perform(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw Failure.server(status: -1, message: nil)
        }

        switch http.statusCode {
        case 200..<300:
            return data
        case 401:
            throw Failure.unauthorized
        default:
            // The server reports failures as {"error": "..."} and those
            // strings are written for people, so they are worth surfacing
            // rather than replacing with a status code.
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?
                .flatMap { $0["error"] as? String }
            throw Failure.server(status: http.statusCode, message: message)
        }
    }

    private func decode<T: Decodable>(_ data: Data, path: String) throws -> T {
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw Failure.decoding("\(path): \(error)")
        }
    }
}
