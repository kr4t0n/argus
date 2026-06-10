package main

import (
	"testing"
)

func TestParseTqdm(t *testing.T) {
	tests := []struct {
		name       string
		line       string
		wantOK     bool
		wantCur    int64
		wantTot    int64
		wantPct    float64
		wantDesc   string
		wantUnit   string
		wantRate   float64
		wantEtaSec float64
	}{
		{
			name:       "vanilla half",
			line:       `50%|█████     | 50/100 [00:10<00:10, 5.00it/s]`,
			wantOK:     true,
			wantCur:    50,
			wantTot:    100,
			wantPct:    50.0,
			wantUnit:   "it/s",
			wantRate:   5.0,
			wantEtaSec: 10,
		},
		{
			name:       "with description",
			line:       `Training: 50%|█████     | 50/100 [00:10<00:10, 5.00it/s]`,
			wantOK:     true,
			wantCur:    50,
			wantTot:    100,
			wantPct:    50.0,
			wantDesc:   "Training",
			wantUnit:   "it/s",
			wantRate:   5.0,
			wantEtaSec: 10,
		},
		{
			name:     "complete",
			line:     `100%|██████████| 100/100 [00:20<00:00, 5.00it/s]`,
			wantOK:   true,
			wantCur:  100,
			wantTot:  100,
			wantPct:  100.0,
			wantUnit: "it/s",
			wantRate: 5.0,
		},
		{
			name:   "no match — plain log",
			line:   `Epoch 5 finished, loss=0.123`,
			wantOK: false,
		},
		{
			name:   "no match — missing percent",
			line:   `|█████     | 50/100 [00:10<00:10, 5.00it/s]`,
			wantOK: false,
		},
		{
			name:       "with ansi colour",
			line:       "\x1b[32mDownloading: 25%|██▌       | 25/100 [00:05<00:15, 5.00MB/s]\x1b[0m",
			wantOK:     true,
			wantCur:    25,
			wantTot:    100,
			wantPct:    25.0,
			wantDesc:   "Downloading",
			wantUnit:   "MB/s",
			wantRate:   5.0,
			wantEtaSec: 15,
		},
		{
			name:       "longer eta in HH:MM:SS",
			line:       `12%|█▏        | 12/100 [01:30<11:00, 0.13it/s]`,
			wantOK:     true,
			wantCur:    12,
			wantTot:    100,
			wantPct:    12.0,
			wantUnit:   "it/s",
			wantRate:   0.13,
			wantEtaSec: 11 * 60,
		},
		{
			name:    "ascii bar",
			line:    `40%|####      | 40/100 [00:08<00:12, 5.00it/s]`,
			wantOK:  true,
			wantCur: 40,
			wantTot: 100,
			wantPct: 40.0,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseTqdm(tt.line)
			if ok != tt.wantOK {
				t.Fatalf("parseTqdm ok=%v, want %v", ok, tt.wantOK)
			}
			if !ok {
				return
			}
			if got.Current != tt.wantCur {
				t.Errorf("current=%d, want %d", got.Current, tt.wantCur)
			}
			if got.Total != tt.wantTot {
				t.Errorf("total=%d, want %d", got.Total, tt.wantTot)
			}
			if got.Percent != tt.wantPct {
				t.Errorf("percent=%v, want %v", got.Percent, tt.wantPct)
			}
			if got.Desc != tt.wantDesc {
				t.Errorf("desc=%q, want %q", got.Desc, tt.wantDesc)
			}
			if tt.wantUnit != "" && got.Unit != tt.wantUnit {
				t.Errorf("unit=%q, want %q", got.Unit, tt.wantUnit)
			}
			if tt.wantRate != 0 && got.Rate != tt.wantRate {
				t.Errorf("rate=%v, want %v", got.Rate, tt.wantRate)
			}
			if tt.wantEtaSec != 0 && got.EtaSeconds != tt.wantEtaSec {
				t.Errorf("eta=%v, want %v", got.EtaSeconds, tt.wantEtaSec)
			}
		})
	}
}

func TestStripANSI(t *testing.T) {
	in := "\x1b[31mred\x1b[0m plain \x1b[1;32mbold green\x1b[0m"
	want := "red plain bold green"
	if got := stripANSI(in); got != want {
		t.Errorf("stripANSI=%q, want %q", got, want)
	}
}
