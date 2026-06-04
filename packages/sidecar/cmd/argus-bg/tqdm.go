package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// tqdmFrame is one parsed tqdm-style progress line.
type tqdmFrame struct {
	Desc       string
	Current    int64
	Total      int64
	Percent    float64
	Elapsed    time.Duration
	EtaSeconds float64
	Rate       float64
	Unit       string
}

// Matches the canonical tqdm rendering:
//
//	<desc>: <pct>%|<bar>| <cur>/<tot> [<elapsed><<eta>, <rate><unit>]
//
// Description is optional; bar characters are any of the standard block
// glyphs, ascii '#', or whitespace. Elapsed / eta look like "00:42" or
// "1:23:45". Unit is whatever trails the rate ("it/s", "MB/s", …).
//
// We do not anchor the regex — tqdm sometimes prefixes the line with a
// carriage-return wash (overwriting the previous frame) or ANSI cursor
// moves, and the description itself may contain arbitrary text. Anything
// before the first "<pct>%|" is ignored.
var tqdmRe = regexp.MustCompile(
	`(?:(?P<desc>[^|\r\n]+?):\s*)?` +
		`(?P<pct>\d+)%\|[\x{2588}\x{258F}\x{258E}\x{258D}\x{258C}\x{258B}\x{258A}\x{2589}#\s]*\|\s*` +
		`(?P<cur>\d+)/(?P<tot>\d+)\s*` +
		`\[(?P<elapsed>[^<]+)<(?P<eta>[^,]+),\s*(?P<rate>[\d.]+)(?P<unit>[^\]]*)\]`,
)

// ansiRe matches CSI sequences (color, cursor moves) and OSC strings.
// We strip these from any candidate tqdm line before regex-matching.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;?]*[a-zA-Z]`)

func stripANSI(s string) string {
	return ansiRe.ReplaceAllString(s, "")
}

// parseTqdm tries to parse one logical line as a tqdm progress frame.
// Returns ok=false on any mismatch; never panics on garbled input.
func parseTqdm(line string) (tqdmFrame, bool) {
	line = stripANSI(line)
	m := tqdmRe.FindStringSubmatch(line)
	if m == nil {
		return tqdmFrame{}, false
	}
	names := tqdmRe.SubexpNames()
	fields := make(map[string]string, len(names))
	for i, name := range names {
		if name != "" {
			fields[name] = m[i]
		}
	}
	cur, _ := strconv.ParseInt(fields["cur"], 10, 64)
	tot, _ := strconv.ParseInt(fields["tot"], 10, 64)
	pct, _ := strconv.ParseFloat(fields["pct"], 64)
	rate, _ := strconv.ParseFloat(fields["rate"], 64)
	elapsed := parseTqdmDuration(fields["elapsed"])
	eta := parseTqdmDuration(fields["eta"])
	return tqdmFrame{
		Desc:       strings.TrimSpace(fields["desc"]),
		Current:    cur,
		Total:      tot,
		Percent:    pct,
		Elapsed:    elapsed,
		EtaSeconds: eta.Seconds(),
		Rate:       rate,
		Unit:       strings.TrimSpace(fields["unit"]),
	}, true
}

// parseTqdmDuration parses "MM:SS" or "HH:MM:SS" (tqdm produces zero-
// padded fields). Returns 0 on any failure, including the "?" tqdm
// shows before it has enough samples to estimate.
func parseTqdmDuration(s string) time.Duration {
	s = strings.TrimSpace(s)
	if s == "" || s == "?" {
		return 0
	}
	parts := strings.Split(s, ":")
	var h, m, sec int64
	var err error
	switch len(parts) {
	case 2:
		m, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0
		}
		sec, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0
		}
	case 3:
		h, err = strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0
		}
		m, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			return 0
		}
		sec, err = strconv.ParseInt(parts[2], 10, 64)
		if err != nil {
			return 0
		}
	default:
		return 0
	}
	return time.Duration(h*3600+m*60+sec) * time.Second
}
