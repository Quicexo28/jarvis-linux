import SwiftUI
import WidgetKit

/// All three home-screen widgets in ONE extension, and that is deliberate: a free
/// Apple ID may register only 10 App IDs per week and hold 3 sideloaded apps at
/// once, and every extension consumes one App ID. Splitting them would burn the
/// budget for nothing — a `WidgetBundle` already lets the user add each tile
/// independently.
@main
struct JarvisWidgetBundle: WidgetBundle {
    var body: some Widget {
        HoloWidget()
        TailscaleWidget()
        DesktopWidget()
    }
}
