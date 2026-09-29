import Foundation
import Testing
@testable import ArgusKit

/// `GET /search/sessions` mirror. Inline JSON in the exact shape of
/// shared-types' `SessionSearchResponse` — a captured fixture
/// (`search-sessions.json`, see scripts/capture-client-fixtures.sh) is the
/// stronger check once one has been recorded against a live server.
@Suite("Search models — SessionSearchResponse decoding")
struct SearchModelsTests {
    @Test("hits decode with sentinel-marked snippets; mode is an open enum")
    func decodesResponse() throws {
        let json = """
        {
          "query": "maxlen",
          "hits": [
            {
              "sessionId": "s1",
              "commandId": "c9",
              "matchCount": 3,
              "snippet": "trims with [[hl]]MAXLEN[[/hl]] ~ N"
            }
          ],
          "mode": "substring"
        }
        """
        let response = try JSONDecoder().decode(SessionSearchResponse.self, from: Data(json.utf8))
        #expect(response.query == "maxlen")
        #expect(response.mode == .substring)
        #expect(response.hits.count == 1)
        #expect(response.hits[0].id == "s1")
        #expect(response.hits[0].matchCount == 3)
        #expect(SearchSnippet.runs(response.hits[0].snippet).contains {
            $0.highlighted && $0.text == "MAXLEN"
        })
    }

    @Test("an unknown search mode never fails the decode")
    func unknownModeTolerated() throws {
        let json = """
        {"query": "x", "hits": [], "mode": "semantic", "futureField": 1}
        """
        let response = try JSONDecoder().decode(SessionSearchResponse.self, from: Data(json.utf8))
        #expect(response.mode == .unknown)
        #expect(response.hits.isEmpty)
    }
}
