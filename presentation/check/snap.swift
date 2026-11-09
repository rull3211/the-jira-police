import AppKit
import WebKit

// usage: snap <outDir> <readRoot> <Preview.html>...  — one PNG per file, the first slide of each; exits 1 if any fails.
let args = CommandLine.arguments
let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
func resolve(_ p: String) -> URL { URL(fileURLWithPath: p, relativeTo: cwd).standardizedFileURL }
let outDir = resolve(args[1])
let readRoot = resolve(args[2])
let files = args.dropFirst(3).map(resolve)
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

final class Loader: NSObject, WKNavigationDelegate {
  var done = false
  var error: Error? = nil
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { done = true }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    self.error = error
    done = true
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    self.error = error
    done = true
  }
}

func spin(until cond: () -> Bool) {
  while !cond() { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 1000, height: 600), styleMask: .borderless, backing: .buffered, defer: false)
window.orderBack(nil)

var failed: [String] = []

for file in files {
  let name = file.deletingLastPathComponent().lastPathComponent.replacingOccurrences(of: ".pptx.qlpreview", with: ".png")
  let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 600))
  window.contentView = web
  let loader = Loader()
  web.navigationDelegate = loader
  web.loadFileURL(file, allowingReadAccessTo: readRoot)
  spin { loader.done }
  if let error = loader.error {
    failed.append("\(name): the page did not load (\(error.localizedDescription))")
    continue
  }
  RunLoop.current.run(until: Date().addingTimeInterval(1.5))

  var rect: CGRect? = nil
  var found = false
  let js = "(() => { const el = document.querySelector('div.slide'); if (!el) { return null; } el.scrollIntoView(); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()"
  web.evaluateJavaScript(js) { result, _ in
    if let a = result as? [Double], a.count == 4 {
      rect = CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
      found = true
    } else {
      rect = .zero
    }
  }
  spin { rect != nil }
  if !found {
    failed.append("\(name): the preview has no slide in it")
    continue
  }
  RunLoop.current.run(until: Date().addingTimeInterval(0.3))

  let cfg = WKSnapshotConfiguration()
  cfg.rect = rect!
  cfg.snapshotWidth = NSNumber(value: 1920)
  var finished = false
  web.takeSnapshot(with: cfg) { image, error in
    defer { finished = true }
    guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else {
      failed.append("\(name): the snapshot failed (\(String(describing: error)))")
      return
    }
    do {
      try png.write(to: outDir.appendingPathComponent(name))
    } catch {
      failed.append("\(name): could not write the PNG (\(error.localizedDescription))")
    }
  }
  spin { finished }
}

for line in failed { FileHandle.standardError.write("\(line)\n".data(using: .utf8)!) }
exit(failed.isEmpty ? 0 : 1)
