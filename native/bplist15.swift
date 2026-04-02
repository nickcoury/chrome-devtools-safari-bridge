/// Minimal bplist15 decoder for WIR messages.
/// bplist15 is Apple's XPC binary plist format, similar to bplist00
/// but with inline/streamed object encoding and type code 0x7 for strings.

import Foundation

enum Bplist15Error: Error {
    case invalidHeader
    case unexpectedType(UInt8, Int)
    case truncated
}

struct Bplist15Decoder {
    let data: Data
    var offset: Int

    init(_ data: Data) {
        self.data = data
        self.offset = 0
    }

    mutating func decode() throws -> Any {
        guard data.count >= 8, data.prefix(8) == Data("bplist15".utf8) else {
            throw Bplist15Error.invalidHeader
        }
        offset = 8
        // Skip preamble integers (type 0x1X markers before the root object)
        while offset < data.count {
            let marker = data[offset]
            let highNibble = marker >> 4
            if highNibble != 0x1 { break } // stop when we hit a non-integer
            // Skip integer: size = 2^(lowNibble)
            let intSize = 1 << (marker & 0x0f)
            offset += 1 + intSize
        }
        return try readObject()
    }

    mutating func readObject() throws -> Any {
        guard offset < data.count else { throw Bplist15Error.truncated }
        let marker = data[offset]
        let highNibble = marker >> 4
        let lowNibble = marker & 0x0f
        offset += 1

        switch highNibble {
        case 0x0: // null / bool / fill
            if lowNibble == 0x0 { return NSNull() }
            if lowNibble == 0x8 { return false }
            if lowNibble == 0x9 { return true }
            return NSNull()

        case 0x1: // integer
            let byteCount = 1 << lowNibble
            guard offset + byteCount <= data.count else { throw Bplist15Error.truncated }
            var value: Int64 = 0
            for i in 0..<byteCount {
                value = (value << 8) | Int64(data[offset + i])
            }
            offset += byteCount
            return NSNumber(value: value)

        case 0x2: // real
            let byteCount = 1 << lowNibble
            guard offset + byteCount <= data.count else { throw Bplist15Error.truncated }
            if byteCount == 8 {
                var bits: UInt64 = 0
                for i in 0..<8 { bits = (bits << 8) | UInt64(data[offset + i]) }
                offset += 8
                return NSNumber(value: Double(bitPattern: bits))
            }
            offset += byteCount
            return NSNumber(value: 0.0)

        case 0x4: // data
            let length = try readLength(lowNibble)
            guard offset + length <= data.count else { throw Bplist15Error.truncated }
            let result = data[offset..<offset+length]
            offset += length
            return result as NSData

        case 0x5, 0x7: // ASCII string
            let length = try readLength(lowNibble)
            guard offset + length <= data.count else { throw Bplist15Error.truncated }
            let str = String(data: data[offset..<offset+length], encoding: .ascii) ?? ""
            offset += length
            return str as NSString

        case 0x6: // Unicode string
            let length = try readLength(lowNibble)
            let byteLen = length * 2
            guard offset + byteLen <= data.count else { throw Bplist15Error.truncated }
            let str = String(data: data[offset..<offset+byteLen], encoding: .utf16BigEndian) ?? ""
            offset += byteLen
            return str as NSString

        case 0xa: // array
            let count = try readLength(lowNibble)
            var arr: [Any] = []
            for _ in 0..<count {
                arr.append(try readObject())
            }
            return arr as NSArray

        case 0xd: // dictionary — keys first, then values (same layout as bplist00)
            let count = try readLength(lowNibble)
            var keys: [Any] = []
            for _ in 0..<count { keys.append(try readObject()) }
            var dict: [String: Any] = [:]
            for i in 0..<count {
                let value = try readObject()
                if let keyStr = keys[i] as? String {
                    dict[keyStr] = value
                }
            }
            return dict as NSDictionary

        default:
            throw Bplist15Error.unexpectedType(marker, offset - 1)
        }
    }

    mutating func readLength(_ lowNibble: UInt8) throws -> Int {
        if lowNibble < 0x0f {
            return Int(lowNibble)
        }
        // Extended length in bplist15:
        // Next byte is 0x1N where N indicates byte count for the length value.
        // The length bytes use high-bit-terminated variable-length encoding.
        guard offset < data.count else { throw Bplist15Error.truncated }
        let sizeMarker = data[offset]
        offset += 1

        if (sizeMarker >> 4) == 0x1 {
            let byteCount = 1 << (sizeMarker & 0x0f)
            // Read length using variable-length encoding (high bit = last byte)
            var value = 0
            for _ in 0..<byteCount {
                guard offset < data.count else { throw Bplist15Error.truncated }
                let b = data[offset]
                offset += 1
                value = (value << 7) | Int(b & 0x7f)
                if (b & 0x80) != 0 { break } // high bit = last byte
            }
            return value
        }
        // Fallback: treat as raw byte
        return Int(sizeMarker)
    }
}

/// Decode bplist15 data to a Foundation object, then re-encode as bplist00
func transcodeBplist15ToBplist00(_ input: Data) -> Data? {
    var decoder = Bplist15Decoder(input)
    guard let obj = try? decoder.decode() else { return nil }
    return try? PropertyListSerialization.data(fromPropertyList: obj, format: .binary, options: 0)
}
