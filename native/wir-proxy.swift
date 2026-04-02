/**
 * WIR XPC-to-Socket Proxy
 *
 * Bridges macOS webinspectord's XPC Mach service to a Unix socket.
 * Transcodes bplist15 (XPC) ↔ bplist00 (socket) so that Node.js
 * libraries (appium-ios-device) can speak the standard WIR protocol.
 *
 * Usage:  ./wir-proxy [socket-path]
 *         Default: /tmp/wir-proxy.sock
 */

import Foundation

let socketPath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : "/tmp/wir-proxy.sock"

// ── Plist transcoding ──────────────────────────────────────────────

/// Decode any-format binary plist, re-encode as bplist00
func transcodeToBplist00(_ data: Data) -> Data? {
    guard let obj = try? PropertyListSerialization.propertyList(
        from: data, options: [], format: nil
    ) else { return nil }
    return try? PropertyListSerialization.data(
        fromPropertyList: obj, format: .binary, options: 0
    )
}

// ── XPC connection to webinspectord ────────────────────────────────

let xpcConn = xpc_connection_create_mach_service("com.apple.webinspector", nil, 0)
var connId = ""
var clientFd: Int32 = -1
let fdLock = NSLock()

func sendToClient(_ rawPlistData: Data) {
    // Transcode bplist15 → bplist00
    guard let plistData = transcodeToBplist00(rawPlistData) else {
        fputs("Warning: failed to transcode plist to bplist00 (\(rawPlistData.count) bytes)\n", stderr)
        return
    }

    fdLock.lock()
    let fd = clientFd
    fdLock.unlock()
    guard fd >= 0 else { return }

    // Write 4-byte big-endian length header + payload
    var len = UInt32(plistData.count).bigEndian
    let headerData = Data(bytes: &len, count: 4)
    let fullMessage = headerData + plistData
    _ = fullMessage.withUnsafeBytes { ptr in
        send(fd, ptr.baseAddress!, fullMessage.count, 0)
    }
}

xpc_connection_set_event_handler(xpcConn) { event in
    let type = xpc_get_type(event)
    guard type == XPC_TYPE_DICTIONARY else { return }

    let msgData = xpc_dictionary_get_value(event, "msgData")
    guard let msgData, xpc_get_type(msgData) == XPC_TYPE_DICTIONARY else { return }

    xpc_dictionary_apply(msgData) { _, value in
        if xpc_get_type(value) == XPC_TYPE_DATA {
            if let ptr = xpc_data_get_bytes_ptr(value) {
                let length = xpc_data_get_length(value)
                let data = Data(bytes: ptr, count: length)
                sendToClient(data)
            }
        }
        return true
    }
}
xpc_connection_resume(xpcConn)

// ── Unix socket server ─────────────────────────────────────────────

unlink(socketPath)

let serverFd = socket(AF_UNIX, SOCK_STREAM, 0)
guard serverFd >= 0 else { fatalError("socket() failed") }

var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
    let bound = MemoryLayout.size(ofValue: addr.sun_path)
    socketPath.withCString { src in
        _ = memcpy(ptr, src, min(socketPath.utf8.count, bound - 1))
    }
}
let bindResult = withUnsafePointer(to: &addr) { ptr in
    ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { ba in
        bind(serverFd, ba, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
}
guard bindResult == 0 else { fatalError("bind() failed: errno=\(errno)") }
guard listen(serverFd, 1) == 0 else { fatalError("listen() failed") }

print("WIR proxy listening on \(socketPath)")
fputs("PID: \(ProcessInfo.processInfo.processIdentifier)\n", stderr)

let pidPath = socketPath + ".pid"
try? "\(ProcessInfo.processInfo.processIdentifier)".write(
    toFile: pidPath, atomically: true, encoding: .utf8
)

func cleanup(_ sig: Int32) {
    unlink(socketPath)
    unlink(pidPath)
    exit(0)
}
signal(SIGINT, cleanup)
signal(SIGTERM, cleanup)

// ── Client handling ────────────────────────────────────────────────

func readExact(_ fd: Int32, _ count: Int) -> Data? {
    var buf = Data(count: count)
    var offset = 0
    while offset < count {
        let n = buf.withUnsafeMutableBytes { ptr in
            recv(fd, ptr.baseAddress! + offset, count - offset, 0)
        }
        if n <= 0 { return nil }
        offset += n
    }
    return buf
}

func handleClient(_ fd: Int32) {
    fdLock.lock()
    clientFd = fd
    fdLock.unlock()

    connId = UUID().uuidString
    print("Client connected (connId: \(connId))")

    // Read loop: length-prefixed binary plists from socket → XPC
    while true {
        guard let headerBuf = readExact(fd, 4) else { break }

        let length = headerBuf.withUnsafeBytes { ptr in
            Int(UInt32(bigEndian: ptr.load(as: UInt32.self)))
        }
        guard length > 0, length < 100_000_000 else { break }

        guard let payload = readExact(fd, length) else { break }

        // The socket sends bplist00 — forward to XPC as-is (XPC accepts both formats)
        let xpcMsg = xpc_dictionary_create(nil, nil, 0)
        let innerDict = xpc_dictionary_create(nil, nil, 0)
        payload.withUnsafeBytes { bytes in
            xpc_dictionary_set_data(innerDict, connId, bytes.baseAddress!, payload.count)
        }
        xpc_dictionary_set_value(xpcMsg, "msgData", innerDict)
        xpc_connection_send_message(xpcConn, xpcMsg)
    }

    print("Client disconnected")
    fdLock.lock()
    clientFd = -1
    fdLock.unlock()
    close(fd)
}

// ── Accept loop ────────────────────────────────────────────────────

while true {
    var clientAddr = sockaddr_un()
    var clientLen = socklen_t(MemoryLayout<sockaddr_un>.size)
    let fd = withUnsafeMutablePointer(to: &clientAddr) { ptr in
        ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { acceptAddr in
            accept(serverFd, acceptAddr, &clientLen)
        }
    }
    guard fd >= 0 else { continue }
    DispatchQueue.global().async {
        handleClient(fd)
    }
}
