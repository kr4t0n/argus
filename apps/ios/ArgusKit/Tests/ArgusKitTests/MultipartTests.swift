import Foundation
import Testing
@testable import ArgusKit

@Suite("Multipart — attachment upload body layout")
struct MultipartTests {
    @Test("body matches the exact multipart/form-data layout")
    func bodyLayout() {
        let payload = Data("hello".utf8)
        let body = Multipart.body(
            boundary: "B",
            fieldName: "file",
            filename: "shot.png",
            mime: "image/png",
            data: payload
        )
        let expected = "--B\r\n"
            + "Content-Disposition: form-data; name=\"file\"; filename=\"shot.png\"\r\n"
            + "Content-Type: image/png\r\n\r\n"
            + "hello"
            + "\r\n--B--\r\n"
        #expect(body == Data(expected.utf8))
        #expect(Multipart.contentType(boundary: "B") == "multipart/form-data; boundary=B")
    }

    @Test("filenames are safe inside the quoted-string")
    func filenameEscaping() {
        let body = Multipart.body(
            boundary: "B",
            fieldName: "file",
            filename: "we\"ird\r\nname\\x.png",
            mime: "image/png",
            data: Data()
        )
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.contains("filename=\"we\\\"irdname\\\\x.png\""))
    }
}
