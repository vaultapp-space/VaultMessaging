import SwiftUI

/// The web client's design system, transcribed.
///
/// Values come from `client/src/app.css` — they are not "close enough"
/// approximations, because the two clients sit side by side on the same
/// account and a different green reads as a different product. When that file
/// changes, this one has to change with it.
enum Vault {

    // MARK: - Palette
    //
    // Dark is the default; the web client ships a `.light` override and this
    // mirrors both so the app follows the system appearance.

    enum Palette {
        static func black(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x09090B) : Color(hex: 0xFAFAFA)
        }
        static func surface(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x111113) : Color(hex: 0xFFFFFF)
        }
        static func elevated(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x18181B) : Color(hex: 0xF4F4F5)
        }
        static func border(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x27272A) : Color(hex: 0xE4E4E7)
        }
        static func text(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0xFAFAFA) : Color(hex: 0x09090B)
        }
        static func textDim(_ scheme: ColorScheme) -> Color {
            Color(hex: 0x71717A)   // identical in both themes
        }
        static func muted(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x52525B) : Color(hex: 0xA1A1AA)
        }
        /// Emerald Cipher. Darkened in light mode for contrast, as on the web.
        static func accent(_ scheme: ColorScheme) -> Color {
            scheme == .dark ? Color(hex: 0x10B981) : Color(hex: 0x059669)
        }
        static let danger = Color(hex: 0xEF4444)
        static let warning = Color(hex: 0xF59E0B)
    }

    // MARK: - Radii

    enum Radius {
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
        static let xxl: CGFloat = 20
    }

    /// Per-user avatar gradient, matching `client/src/lib/avatar.js`.
    ///
    /// The same hash, the same 120° hue offset and the same saturation and
    /// lightness — so a person's avatar is the same colour on both clients.
    /// That is the point: an avatar that changes colour between devices stops
    /// being recognisable at a glance.
    static func avatarGradient(for username: String?) -> LinearGradient {
        guard let username, !username.isEmpty else {
            return LinearGradient(
                colors: [Color(hex: 0x1F1F2E), Color(hex: 0x11111B)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        }

        // Int32 arithmetic, matching JavaScript's `(hash << 5) - hash` on a
        // 32-bit signed integer. Swift's Int is 64-bit, so this has to wrap
        // deliberately or the hues drift apart from the web.
        var hash: Int32 = 0
        for scalar in username.unicodeScalars {
            let code = Int32(truncatingIfNeeded: Int(scalar.value))
            hash = code &+ ((hash << 5) &- hash)
        }

        let h1 = Double(abs(Int(hash)) % 360)
        let h2 = (h1 + 120).truncatingRemainder(dividingBy: 360)

        return LinearGradient(
            colors: [
                Color(hue: h1 / 360, saturation: 0.65, brightness: 0.72),
                Color(hue: h2 / 360, saturation: 0.60, brightness: 0.40),
            ],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }
}

/// The shield mark from the web client's header, as a Shape.
///
/// Traced from the same SVG path so the two are the same logo rather than two
/// drawings of a similar idea. The 24×24 viewBox is scaled to whatever frame
/// it is given.
struct VaultShield: View {
    var lineWidth: CGFloat = 2
    var color: Color

    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height) / 24

            ZStack {
                // M12 2L4 7v6c0 5.25 3.4 10.15 8 11.25 4.6-1.1 8-6 8-11.25V7l-8-5z
                Path { p in
                    p.move(to: CGPoint(x: 12 * s, y: 2 * s))
                    p.addLine(to: CGPoint(x: 4 * s, y: 7 * s))
                    p.addLine(to: CGPoint(x: 4 * s, y: 13 * s))
                    p.addCurve(
                        to: CGPoint(x: 12 * s, y: 24.25 * s),
                        control1: CGPoint(x: 4 * s, y: 18.25 * s),
                        control2: CGPoint(x: 7.4 * s, y: 23.15 * s)
                    )
                    p.addCurve(
                        to: CGPoint(x: 20 * s, y: 13 * s),
                        control1: CGPoint(x: 16.6 * s, y: 23.15 * s),
                        control2: CGPoint(x: 20 * s, y: 18.25 * s)
                    )
                    p.addLine(to: CGPoint(x: 20 * s, y: 7 * s))
                    p.closeSubpath()
                }
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineJoin: .round))

                // The dashed stem: M12 22V12
                Path { p in
                    p.move(to: CGPoint(x: 12 * s, y: 22 * s))
                    p.addLine(to: CGPoint(x: 12 * s, y: 12 * s))
                }
                .stroke(color, style: StrokeStyle(
                    lineWidth: lineWidth, lineCap: .round, dash: [3 * s, 3 * s]
                ))
            }
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

extension Color {
    /// 0xRRGGBB, so the hex values can be copied straight out of app.css.
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}
