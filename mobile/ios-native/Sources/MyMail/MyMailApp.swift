#if canImport(SwiftUI)
import SwiftUI
import MyMailKit

/// A native SwiftUI shell focused on the mobile killer feature: approving what agents want to send.
@main
struct MyMailApp: App {
    @State private var model = ApprovalsModel()
    var body: some Scene {
        WindowGroup {
            RootView().environment(model).preferredColorScheme(.dark).tint(Color(red: 1, green: 0.416, blue: 0.239))
        }
    }
}
#endif
