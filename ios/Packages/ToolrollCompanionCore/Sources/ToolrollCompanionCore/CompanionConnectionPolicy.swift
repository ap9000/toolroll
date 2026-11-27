import Foundation

// MARK: - Error classes (contract §2.7)

/// What the person can do about a Mac that can't be reached right now. The phone keeps retrying in every case.
public enum CompanionUnreachableHint: Equatable, Hashable, Sendable {
    /// Nothing specific is known (the Mac asleep, Toolroll not running, phone access off, no network).
    case generic
    /// No direct address answered and the Mac offers no hosted relay.
    case noPath
    /// A direct address answered for a different machine: Toolroll was reset or restored on the Mac (or another
    /// machine took its address).
    case differentMachine
    /// The relay answered but the Mac isn't connected to it.
    case macOffline
    /// The relay refused the token's time window twice: this iPhone's clock is off.
    case clockSkew
    /// The relay asked this iPhone to slow down.
    case rateLimited
    /// Some other relay refusal (its code, for logs).
    case relayRefused(String)
    /// The keychain can't be read right now (the iPhone hasn't been unlocked since it started, or a transient error).
    case keychainUnavailable
    /// The Mac answered in a way this build doesn't understand.
    case protocolMismatch
}

/// Why a connection to the Mac couldn't be made or was lost.
public enum CompanionConnectionError: Error, Equatable, Sendable {
    /// Retrying: the Mac or the relay couldn't be reached, or answered with something that proves nothing.
    case unreachable(CompanionUnreachableHint)
    /// The Mac (authenticated: msg2 `refused`, a stream-0 ERROR, `standing_revoked`) or the relay (403
    /// `device_revoked`) says this iPhone no longer belongs. Terminal: no retries.
    case refused(String)
    /// This iPhone's own pairing record or keys are unreadable or invalid, or the Mac's identity didn't match. Terminal.
    case damaged(String)
    /// The session ended (socket closed, missed pong, or this client disconnected).
    case closed
}

/// A pairing that reached the Mac but didn't finish. Never retried: the person starts again on the Mac.
public enum CompanionPairingError: Error, Equatable, Sendable {
    /// The owner cancelled on the Mac.
    case cancelled
    /// The code ran out (the Mac said so, or the phone's own deadline from `expiresAtMs` passed).
    case expired
    /// Another device used the same code.
    case contested
    /// The Mac couldn't finish (a relay didn't admit the phone, the account changed).
    case failed
    /// The connection dropped after message 1, before an outcome.
    case interrupted

    /// Maps a `pair.ready` ERROR code.
    public init(code: String) {
        switch code {
        case "pairing_cancelled": self = .cancelled
        case "pairing_expired": self = .expired
        case "pairing_contested": self = .contested
        default: self = .failed
        }
    }

    public var title: String {
        switch self {
        case .cancelled: return "Pairing cancelled"
        case .expired: return "The code expired"
        case .contested: return "Another device used this code"
        case .failed, .interrupted: return "Pairing didn't finish"
        }
    }

    public var userMessage: String {
        switch self {
        case .cancelled: return "Pairing was cancelled on your Mac. To try again, choose Pair an iPhone there."
        case .expired: return "The code expired. Start again on your Mac."
        case .contested: return "Another device used this code, so your Mac stopped pairing. Start again on your Mac."
        case .failed: return "Your Mac couldn't finish pairing. Start again on your Mac."
        case .interrupted: return "The connection to your Mac dropped while pairing. Start again on your Mac."
        }
    }
}

// MARK: - Policy

/// The phone's connection decisions in one testable place: what an error means for the screen, whether to keep
/// retrying, what the person reads, and the backoff.
public enum CompanionConnectionPolicy {
    /// Automatic reconnects while the Mac can't be reached: 2, 5, 15, then every 30 seconds.
    public static let retryDelays: [Duration] = [.seconds(2), .seconds(5), .seconds(15), .seconds(30)]

    public static func retryDelay(attempt: Int) -> Duration {
        retryDelays[min(max(attempt, 0), retryDelays.count - 1)]
    }

    public enum Verdict: Equatable, Sendable {
        case unreachable(CompanionUnreachableHint)
        /// Terminal: stop retrying, delete the offline snapshot, offer Pair again / Remove from this iPhone.
        case refused(reason: String)
        /// Terminal: as `refused`, with the damaged copy.
        case damaged
        /// A newer attempt (or a disconnect) took over: publish nothing.
        case superseded

        public var retries: Bool {
            if case .unreachable = self { return true }
            return false
        }

        /// The offline snapshot must go (contract §6: deleted on refused and damaged).
        public var dropsSnapshot: Bool {
            switch self {
            case .refused, .damaged: return true
            default: return false
            }
        }
    }

    /// What a failed connect means.
    public static func verdict(for error: Error) -> Verdict {
        switch error {
        case let error as CompanionConnectionError:
            switch error {
            case .unreachable(let hint): return .unreachable(hint)
            case .refused(let reason): return .refused(reason: reason)
            case .damaged: return .damaged
            case .closed: return .superseded
            }
        case let rpc as CompanionRPCError where rpc.code == CompanionRPCError.standingRevoked:
            return .refused(reason: CompanionStreamZeroCode.accountRevoked)
        case is CancellationError:
            return .superseded
        default:
            return .unreachable(.generic)
        }
    }

    /// The line under "Can't reach your Mac". Always something to do; never a guess presented as fact.
    public static func hintMessage(_ hint: CompanionUnreachableHint) -> String {
        switch hint {
        case .generic:
            return "Make sure your Mac is awake, Toolroll is running, and phone access is on (Settings → Phone)."
        case .noPath:
            return noPathMessage
        case .differentMachine:
            return "Toolroll on your Mac was reset or restored. Pair again."
        case .macOffline:
            return "Your Mac is offline. Toolroll will reconnect when it's back."
        case .clockSkew:
            return "Check the iPhone's date & time: Settings → General → Date & Time."
        case .rateLimited:
            return "The relay asked this iPhone to slow down. Trying again shortly."
        case .relayRefused:
            return "The relay didn't accept this connection. Trying again."
        case .keychainUnavailable:
            return "Unlock this iPhone to connect to your Mac."
        case .protocolMismatch:
            return "Update Toolroll on your Mac and this iPhone."
        }
    }

    /// Shown when no direct address answers and the Mac offers no hosted relay.
    public static let noPathMessage =
        "Can't reach your Mac. Connect to the same Wi-Fi as your Mac (or Tailscale), or turn on 'Connect from anywhere' in Toolroll → Settings → Phone."

    /// The refused card.
    public static func refusedMessage(reason: String) -> (title: String, body: String) {
        switch reason {
        case CompanionStreamZeroCode.accountRevoked:
            return (
                "Your Mac removed this iPhone",
                "The account this iPhone was paired with changed on your Mac (a new password, or its access changed). Pair it again to keep using it."
            )
        default:
            return (
                "Your Mac removed this iPhone",
                "It was removed in Toolroll → Settings → Phone on your Mac. Pair it again to keep using it."
            )
        }
    }

    public static let damagedMessage = (
        title: "Pairing data is damaged",
        body: "This iPhone's pairing data is damaged. Pair again."
    )
}

// MARK: - RPC copy

extension CompanionRPCError {
    /// Every code the Mac sends (src/companion/daemon.ts, framing.ts, reads.ts) and the phone's own.
    public static let standingRevoked = "standing_revoked"
    public static let tooManyStreams = "too_many_streams"
    public static let memoryLimit = "memory_limit"
    public static let idleTimeout = "idle_timeout"
    public static let unavailable = "unavailable"
    public static let unsupported = "unsupported"
    public static let routeNotAllowed = "route_not_allowed"
    public static let invalidParams = "invalid_params"
    public static let handlerError = "handler_error"
    public static let protocolError = "protocol_error"
    public static let invalidJSON = "invalid_json"
    public static let helloRequired = "hello_required"
}

public enum CompanionCopy {
    /// User-facing words for a failed read.
    public static func loadFailure(_ error: Error) -> String {
        if let rpc = error as? CompanionRPCError { return loadFailure(code: rpc.code) }
        if let connection = error as? CompanionConnectionError {
            switch connection {
            case .refused: return "Your Mac removed this iPhone."
            case .damaged: return CompanionConnectionPolicy.damagedMessage.body
            default: return "Can't reach your Mac."
            }
        }
        return "Couldn't load. Try again."
    }

    public static func loadFailure(code: String) -> String {
        switch code {
        case CompanionRPCError.notFound:
            return "This isn't on your Mac anymore, or this account can't see it."
        case CompanionRPCError.deadlineExceeded:
            return "Your Mac took too long to answer."
        case CompanionRPCError.invalidResponse, CompanionRPCError.unsupported, CompanionRPCError.routeNotAllowed,
             CompanionRPCError.invalidParams, CompanionRPCError.protocolError, CompanionRPCError.invalidJSON,
             CompanionRPCError.helloRequired:
            return "Your Mac and this iPhone don't agree on this. Update Toolroll on your Mac and this iPhone."
        case CompanionRPCError.responseTooLarge:
            return "This is too large to show on a phone. Open it on your Mac."
        case CompanionRPCError.standingRevoked:
            return "Your Mac removed this iPhone."
        case CompanionRPCError.tooManyStreams:
            return "Too many things are loading at once. Close a live view and try again."
        case CompanionRPCError.memoryLimit:
            return "Your Mac is busy sending other things to this iPhone. Try again in a moment."
        case CompanionRPCError.idleTimeout:
            return "Live output paused while this iPhone wasn't reading. Try again."
        case CompanionRPCError.unavailable:
            return "This isn't available on your Mac right now. Try again in a moment."
        case CompanionRPCError.invalidCursor:
            return "The list changed while loading. Pull to refresh."
        case CompanionRPCError.handlerError:
            return "Something went wrong reading that on your Mac. Try again."
        default:
            return "Couldn't load. Try again."
        }
    }
}
