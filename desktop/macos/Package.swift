// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NeedlefishDesktop",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "NeedlefishDesktop", targets: ["NeedlefishDesktop"])],
    targets: [
        .executableTarget(name: "NeedlefishDesktop"),
        .testTarget(name: "NeedlefishDesktopTests", dependencies: ["NeedlefishDesktop"]),
    ]
)
