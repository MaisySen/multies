// swift-tools-version: 6.0
// MyMail native iOS shell, built with xtool (https://github.com/xtool-org/xtool) on Linux.
// MyMailKit is plain Foundation, so it also builds and tests on Linux with no iOS SDK.
import PackageDescription

let package = Package(
    name: "MyMail",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        // xtool expects exactly one library product: the app.
        .library(name: "MyMail", targets: ["MyMail"]),
    ],
    targets: [
        .target(name: "MyMailKit"),
        .target(name: "MyMail", dependencies: ["MyMailKit"]),
        .testTarget(name: "MyMailKitTests", dependencies: ["MyMailKit"]),
    ]
)
