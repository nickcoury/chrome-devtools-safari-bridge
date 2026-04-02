import Foundation

print("Connecting to com.apple.webinspector Mach service...")

let connection = xpc_connection_create_mach_service("com.apple.webinspector", nil, 0)

xpc_connection_set_event_handler(connection) { event in
    let desc = String(cString: xpc_copy_description(event))
    print("RECEIVED (\(desc.count) chars):")
    print(String(desc.prefix(3000)))
    print("---")
}

xpc_connection_resume(connection)
print("Connection resumed")

// Method: Send WIR messages as direct XPC dictionaries
let msg = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_string(msg, "__selector", "_rpc_reportIdentifier:")
let arg = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_string(arg, "WIRConnectionIdentifierKey", "probe-\(ProcessInfo.processInfo.processIdentifier)")
xpc_dictionary_set_value(msg, "__argument", arg)
xpc_connection_send_message(connection, msg)
print("Sent _rpc_reportIdentifier")

let msg2 = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_string(msg2, "__selector", "_rpc_getConnectedApplications:")
let arg2 = xpc_dictionary_create(nil, nil, 0)
xpc_dictionary_set_string(arg2, "WIRConnectionIdentifierKey", "probe-\(ProcessInfo.processInfo.processIdentifier)")
xpc_dictionary_set_value(msg2, "__argument", arg2)
xpc_connection_send_message(connection, msg2)
print("Sent _rpc_getConnectedApplications")

print("Waiting 5s for responses...")
RunLoop.current.run(until: Date(timeIntervalSinceNow: 5))
print("Done.")
