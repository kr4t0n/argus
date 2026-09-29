package app.argus.core.model

import app.argus.core.ArgusJson
import app.argus.core.engine.SearchSnippet
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// Port of apps/ios/ArgusKit/Tests/ArgusKitTests/SearchModelsTests.swift.

/**
 * `GET /search/sessions` mirror. Inline JSON in the exact shape of
 * shared-types' `SessionSearchResponse` — a captured fixture
 * (`search-sessions.json`, see scripts/capture-ios-fixtures.sh) is the
 * stronger check once one has been recorded against a live server.
 */
class SearchModelsTest {
    /** Hits decode with sentinel-marked snippets; mode is an open enum. */
    @Test
    fun decodesResponse() {
        val json = """
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
        """.trimIndent()
        val response = ArgusJson.decodeFromString<SessionSearchResponse>(json)
        assertEquals("maxlen", response.query)
        assertEquals(SearchMode.SUBSTRING, response.mode)
        assertEquals(1, response.hits.size)
        assertEquals("s1", response.hits[0].sessionId)
        assertEquals(3, response.hits[0].matchCount)
        assertTrue(
            SearchSnippet.runs(response.hits[0].snippet).any {
                it.highlighted && it.text == "MAXLEN"
            },
        )
    }

    /** An unknown search mode never fails the decode. */
    @Test
    fun unknownModeTolerated() {
        val json = """{"query": "x", "hits": [], "mode": "semantic", "futureField": 1}"""
        val response = ArgusJson.decodeFromString<SessionSearchResponse>(json)
        assertEquals(SearchMode.UNKNOWN, response.mode)
        assertTrue(response.hits.isEmpty())
    }
}
