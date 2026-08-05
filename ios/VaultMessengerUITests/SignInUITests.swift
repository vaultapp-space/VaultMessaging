import XCTest

/// End-to-end against a real server.
///
/// This exists because "it compiles" says nothing about whether the app can
/// talk to the backend. The single most breakable thing is the password
/// derivation: the server never sees the password, only a PBKDF2+HMAC
/// derivation of it, and if Swift computes that differently the login is
/// rejected with the same message as a wrong password. Nothing else would
/// point at the cause.
///
/// Credentials come from the environment so the test needs no fixture and no
/// account baked into the repository.
final class SignInUITests: XCTestCase {

    /// The chat list's header subtitle. There is no navigation bar to assert
    /// on — the app draws its own header, as the web client does — so this is
    /// the marker that the list is on screen.
    private static let chatListMarker = "End-to-end encrypted"

    func testSignsInAndReachesTheChatList() throws {
        let app = try signedInApp()

        // Reaching the list means the derived credential was accepted, the
        // session cookie stuck, and /api/chats answered.
        XCTAssertTrue(
            app.staticTexts[Self.chatListMarker].waitForExistence(timeout: 30),
            "did not reach the chat list — check the derived credential"
        )

        // The tabs are the app's whole navigation; if they are missing,
        // Settings and Profile are unreachable however well sign-in worked.
        for tab in ["Chats", "Settings", "Profile"] {
            XCTAssertTrue(app.tabBars.buttons[tab].exists, "\(tab) tab missing")
        }

        capture(app, "chat-list")
    }

    /// Drives the app through its screens and attaches a shot of each, so a
    /// reviewer can see what the build actually looks like rather than
    /// inferring it from assertions.
    func testWalkthrough() throws {
        let app = try signedInApp()
        XCTAssertTrue(app.staticTexts[Self.chatListMarker].waitForExistence(timeout: 30))
        sleep(1)
        capture(app, "2-chat-list")

        // Into a conversation. Asserted rather than skipped when absent: an
        // `if` here turns "the chat list came back empty" into a passing run
        // with two fewer screenshots, which is how a regression goes unnoticed.
        let firstChat = app.buttons.matching(identifier: "chat-row").firstMatch
        XCTAssertTrue(firstChat.waitForExistence(timeout: 30), "no chats in the list")
        do {
            firstChat.tap()
            sleep(2)
            capture(app, "3-conversation")

            let composer = app.textFields["Type a message..."]
            if composer.waitForExistence(timeout: 5) {
                composer.tap()
                composer.typeText("Sent from iOS")
                app.buttons["Send"].firstMatch.tap()
                sleep(3)
                capture(app, "4-sent")
            }
            app.buttons["Back"].firstMatch.tap()
            sleep(1)
        }

        app.tabBars.buttons["Settings"].tap()
        sleep(2)
        capture(app, "5-settings")

        app.tabBars.buttons["Profile"].tap()
        sleep(1)
        capture(app, "6-profile")
    }

    // MARK: - Helpers

    /// Launches and, if the sign-in screen is showing, signs in. A restored
    /// session is not a failure: the cookie surviving between runs is the
    /// app working, so the test has to tolerate landing straight on the list.
    private func signedInApp() throws -> XCUIApplication {
        guard
            let username = Self.setting("VAULT_TEST_USERNAME"),
            let password = Self.setting("VAULT_TEST_PASSWORD")
        else {
            throw XCTSkip("Set VAULT_TEST_USERNAME and VAULT_TEST_PASSWORD to run this.")
        }

        let app = XCUIApplication()
        app.launch()

        // The welcome screen is shown once per install, so a fresh simulator
        // sees it and a re-run does not. Both have to work, or the suite
        // passes locally and fails on a clean machine.
        let start = app.buttons["start-messaging"]
        if start.waitForExistence(timeout: 10) {
            capture(app, "0-welcome")
            start.tap()
        }

        // A restored session is not a failure — the cookie surviving between
        // runs is the app working — so landing straight on the chat list is
        // allowed. Anything else is a real failure and has to say so rather
        // than quietly skipping the sign-in it was asked to test.
        let usernameField = app.textFields["Username"]
        if !usernameField.waitForExistence(timeout: 20) {
            if app.tabBars.buttons["Chats"].exists { return app }
            capture(app, "stuck-before-sign-in")
            XCTFail("neither the sign-in form nor a restored session appeared")
            return app
        }
        // The welcome screen cross-fades into this one. Typing into a field
        // that exists but is still mid-transition drops the keystrokes and
        // then fails 30 seconds later at the chat list, pointing nowhere near
        // the cause.
        XCTAssertTrue(usernameField.waitForExistence(timeout: 5))
        capture(app, "1-sign-in")

        type(username, into: usernameField)
        type(password, into: app.secureTextFields["Password"])

        app.buttons["Unlock Vault"].tap()

        // The simulator's "Save Password?" sheet would otherwise sit over
        // every screenshot that follows.
        let notNow = app.buttons["Not Now"]
        if notNow.waitForExistence(timeout: 5) { notNow.tap() }

        return app
    }

    /// Depending on how the run was invoked, Xcode hands these to the runner
    /// either verbatim or still carrying the `TEST_RUNNER_` prefix it uses to
    /// forward variables on to the app. Accept both rather than silently
    /// skipping, which is what a missing variable looks like from the log.
    private static func setting(_ name: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        return env[name] ?? env["TEST_RUNNER_" + name]
    }

    /// Types and confirms it landed. `typeText` into a view that is still
    /// animating silently does nothing, and a retry is cheaper than a failure
    /// that looks like a rejected password.
    private func type(_ text: String, into field: XCUIElement) {
        for attempt in 0..<3 {
            field.tap()
            field.typeText(text)
            // Secure fields report their value as bullets, so only the fact
            // that something arrived can be checked, not what.
            let value = field.value as? String ?? ""
            if !value.isEmpty && value != field.placeholderValue { return }
            if attempt < 2 { usleep(500_000) }
        }
        XCTFail("could not type into \(field)")
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
