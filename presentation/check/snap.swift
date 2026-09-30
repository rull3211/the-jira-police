import AppKit
import WebKit

// usage: snap <outDir> <readRoot> <Preview.html>...  — one PNG per file, the first slide of each.
let args = CommandLine.arguments
let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func resolve(_ p: String) -> URL { URL(fileURLWithPath: p, relativeTo: cwd).standardizedFileURL }
let outDir = resolve(args[1])
let readRoot = resolve(args[2])
let files = args.dropFirst(3).map(resolve)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

final class Loader: NSObject, WKNavigationDelegate {
  var done = false
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done = true }
}

func spin(until cond: () -> Bool) {
  while !cond() { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 1000, height: 600), styleMask: .borderless, backing: .buffered, defer: false)
window.orderBack(nil)

for file in files {
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 600))
  window.contentView = web
  let loader = Loader()
  web.navigationDelegate = loader
  web.loadFileURL(file, allowingReadAccessTo: readRoot)
  spin { loader.done }
  RunLoop.current.run(until: Date().addingTimeInterval(1.5))

  var rect: CGRect? = nil
  let js = "(() => { const el = document.querySelector('div.slide'); el.scrollIntoView(); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()"
  web.evaluateJavaScript(js) { result, _ in
    if let a = result as? [Double], a.count == 4 { rect = CGRect(x: a[0], y: a[1], width: a[2], height: a[3]) } else { rect = .zero }
  }
  spin { rect != nil }
  RunLoop.current.run(until: Date().addingTimeInterval(0.3))

  let cfg = WKSnapshotConfiguration()
  cfg.rect = rect!
  cfg.snapshotWidth = NSNumber(value: 1920)
  var finished = false
  let name = file.deletingLastPathComponent().lastPathComponent.replacingOccurrences(of: ".pptx.qlpreview", with: ".png")
  web.takeSnapshot(with: cfg) { image, error in
    if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
      try? png.write(to: outDir.appendingPathComponent(name))
    } else {
      print("\(name) failed: \(String(describing: error))")
    }
    finished = true
  }
  spin { finished }
}
print("done")
