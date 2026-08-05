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

    func testSignsInAndReachesTheChatList() throws {
        let env = ProcessInfo.processInfo.environment
        guard
            let username = env["VAULT_TEST_USERNAME"],
            let password = env["VAULT_TEST_PASSWORD"]
        else {
            throw XCTSkip("Set VAULT_TEST_USERNAME and VAULT_TEST_PASSWORD to run this.")
        }

        let app = XCUIApplication()
        app.launch()

        let usernameField = app.textFields["Username"]
        XCTAssertTrue(usernameField.waitForExistence(timeout: 10), "sign-in screen did not appear")
        usernameField.tap()
        usernameField.typeText(username)

        let passwordField = app.secureTextFields["Password"]
        passwordField.tap()
        passwordField.typeText(password)

        app.buttons["Sign in"].tap()

        // The chat list is the proof: reaching it means the derived credential
        // was accepted, the session cookie stuck, and /api/chats answered.
        XCTAssertTrue(
            app.navigationBars["Chats"].waitForExistence(timeout: 30),
            "did not reach the chat list — check the derived credential"
        )

        // Attached so a failure (or a review) can see what the list actually
        // looked like, rather than only that an assertion passed.
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "chat-list"
        shot.lifetime = .keepAlways
        add(shot)
    }
}
