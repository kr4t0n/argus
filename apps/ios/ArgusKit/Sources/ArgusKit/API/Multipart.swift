import Foundation

/// Minimal multipart/form-data encoder for the one endpoint that needs
/// it (`POST /attachments`, field name `file` — see the web's
/// `uploadAttachment`). Internal + deterministic so tests can assert the
/// exact byte layout.
enum Multipart {
    static func contentType(boundary: String) -> String {
        "multipart/form-data; boundary=\(boundary)"
    }

    static func body(
        boundary: String,
        fieldName: String,
        filename: String,
        mime: String,
        data: Data
    ) -> Data {
        // Quoted-string context: strip CR/LF, escape backslash + quote.
        let safeName = filename
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")

        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data(
            "Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(safeName)\"\r\n".utf8
        ))
        body.append(Data("Content-Type: \(mime)\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }
}

extension ArgusClient {
    /// Upload one file ahead of sending a turn; pass the returned id in
    /// `CreateCommandRequest.attachmentIds`. Server caps: 25 MiB/file,
    /// 10 files/turn (413/400 surface as APIError).
    public func uploadAttachment(
        filename: String,
        mime: String,
        data: Data
    ) async throws -> AttachmentDTO {
        let boundary = "argus-\(UUID().uuidString)"
        return try await sendMultipart(
            path: "/attachments",
            contentType: Multipart.contentType(boundary: boundary),
            body: Multipart.body(
                boundary: boundary,
                fieldName: "file",
                filename: filename,
                mime: mime,
                data: data
            )
        )
    }
}
