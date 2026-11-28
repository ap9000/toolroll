import AuthenticationServices
import Foundation
import ToolrollCompanionCore
import UIKit

/// Native iOS WebAuthn Passkey controller (`ASAuthorizationPlatformPublicKeyCredentialProvider`) for ADR 0005.
/// Associated Domain `webcredentials:toolroll.dev` authorizes invoking the system sheet; all cryptographic
/// verification runs locally on the user's Mac.
@MainActor
final class PasskeyManager: NSObject {
    struct RegistrationOutput: Sendable {
        let credentialId: String
        let clientDataJSON: String
        let attestationObject: String
    }

    enum PasskeyError: LocalizedError {
        case cancelled
        case invalidChallenge
        case missingUserHandle
        case noWindow
        case unsupportedResponse
        case authorizationFailed(String)

        var errorDescription: String? {
            switch self {
            case .cancelled:
                return nil
            case .invalidChallenge:
                return "Couldn't read the passkey challenge from your Mac."
            case .missingUserHandle:
                return "iOS didn't return a passkey user identifier. Try again."
            case .noWindow:
                return "Couldn't open the passkey sheet right now."
            case .unsupportedResponse:
                return "Unexpected passkey response from iOS."
            case .authorizationFailed(let message):
                return message
            }
        }
    }

    private var registerContinuation: CheckedContinuation<RegistrationOutput, Error>?
    private var assertContinuation: CheckedContinuation<WebAuthnAssertion, Error>?
    private var activeController: ASAuthorizationController?

    func register(challengeB64Url: String, rpId: String, userIdB64Url: String, userName: String) async throws -> RegistrationOutput {
        guard let challenge = CompanionRelayAuth.base64UrlDecode(challengeB64Url),
              let userId = CompanionRelayAuth.base64UrlDecode(userIdB64Url) else {
            throw PasskeyError.invalidChallenge
        }
        guard presentationWindow() != nil else {
            throw PasskeyError.noWindow
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: userName, userID: userId)
        request.userVerificationPreference = .required

        return try await withCheckedThrowingContinuation { continuation in
            self.registerContinuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.activeController = controller
            controller.performRequests()
        }
    }

    func assert(challengeB64Url: String, rpId: String, allowCredentialIds: [String]) async throws -> WebAuthnAssertion {
        guard let challenge = CompanionRelayAuth.base64UrlDecode(challengeB64Url) else {
            throw PasskeyError.invalidChallenge
        }
        guard presentationWindow() != nil else {
            throw PasskeyError.noWindow
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        let descriptors = allowCredentialIds.compactMap(CompanionRelayAuth.base64UrlDecode).map {
            ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
        }
        if !descriptors.isEmpty {
            request.allowedCredentials = descriptors
        }

        return try await withCheckedThrowingContinuation { continuation in
            self.assertContinuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.activeController = controller
            controller.performRequests()
        }
    }

    private func presentationWindow() -> ASPresentationAnchor? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first
    }
}

// AuthenticationServices calls the delegate and the presentation-context provider on the main thread (the controller is
// created and run from the main actor here), so `MainActor.assumeIsolated` holds. Each continuation is resumed once and
// cleared right after.
extension PasskeyManager: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated {
            self.activeController = nil
            if let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
                guard let attestationObject = reg.rawAttestationObject else {
                    self.registerContinuation?.resume(throwing: PasskeyError.unsupportedResponse)
                    self.registerContinuation = nil
                    return
                }
                let out = RegistrationOutput(
                    credentialId: CompanionRelayAuth.base64UrlEncode(reg.credentialID),
                    clientDataJSON: CompanionRelayAuth.base64UrlEncode(reg.rawClientDataJSON),
                    attestationObject: CompanionRelayAuth.base64UrlEncode(attestationObject)
                )
                self.registerContinuation?.resume(returning: out)
                self.registerContinuation = nil
                return
            }

            if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
                guard let rawAuthData = assertion.rawAuthenticatorData,
                      let signature = assertion.signature else {
                    self.assertContinuation?.resume(throwing: PasskeyError.unsupportedResponse)
                    self.assertContinuation = nil
                    return
                }
                guard let userID = assertion.userID, !userID.isEmpty else {
                    self.assertContinuation?.resume(throwing: PasskeyError.missingUserHandle)
                    self.assertContinuation = nil
                    return
                }
                let out = WebAuthnAssertion(
                    credentialId: CompanionRelayAuth.base64UrlEncode(assertion.credentialID),
                    clientDataJSON: CompanionRelayAuth.base64UrlEncode(assertion.rawClientDataJSON),
                    authenticatorData: CompanionRelayAuth.base64UrlEncode(rawAuthData),
                    signature: CompanionRelayAuth.base64UrlEncode(signature),
                    userHandle: CompanionRelayAuth.base64UrlEncode(userID)
                )
                self.assertContinuation?.resume(returning: out)
                self.assertContinuation = nil
                return
            }

            self.registerContinuation?.resume(throwing: PasskeyError.unsupportedResponse)
            self.registerContinuation = nil
            self.assertContinuation?.resume(throwing: PasskeyError.unsupportedResponse)
            self.assertContinuation = nil
        }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        MainActor.assumeIsolated {
            self.activeController = nil
            let mapped: Error
            if let authErr = error as? ASAuthorizationError, authErr.code == .canceled {
                mapped = PasskeyError.cancelled
            } else {
                mapped = PasskeyError.authorizationFailed(error.localizedDescription)
            }
            self.registerContinuation?.resume(throwing: mapped)
            self.registerContinuation = nil
            self.assertContinuation?.resume(throwing: mapped)
            self.assertContinuation = nil
        }
    }
}

extension PasskeyManager: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            presentationWindow() ?? ASPresentationAnchor()
        }
    }
}
