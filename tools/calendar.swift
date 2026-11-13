// Prints the Calendar app's events between two ISO times as one JSON array.
// EventKit expands repeating meetings (AppleScript doesn't). Exit 2 with NO_ACCESS when permission is denied.
import EventKit
import Foundation

let args = CommandLine.arguments
let iso = ISO8601DateFormatter()
let isoFraction = ISO8601DateFormatter()
isoFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
func parse(_ s: String) -> Date? { iso.date(from: s) ?? isoFraction.date(from: s) }
guard args.count == 3, let from = parse(args[1]), let to = parse(args[2]) else {
  FileHandle.standardError.write("usage: calendar-helper <fromISO> <toISO>\n".data(using: .utf8)!)
  exit(64)
}

let store = EKEventStore()
let done = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in granted = ok; done.signal() }
done.wait()
guard granted else {
  FileHandle.standardError.write("NO_ACCESS\n".data(using: .utf8)!)
  exit(2)
}

let events = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil))
let out: [[String: Any]] = events.map { e in
  let me = e.attendees?.first { $0.isCurrentUser }
  return [
    "title": e.title ?? "",
    "start": iso.string(from: e.startDate),
    "end": iso.string(from: e.endDate),
    "allDay": e.isAllDay,
    "canceled": e.status == .canceled,
    "declined": me?.participantStatus == .declined,
  ]
}
let data = try JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
