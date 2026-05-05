package updater

import "testing"

// TestCompareVersion locks in the SemVer 2.0.0 precedence rules
// pickLatestRelease relies on. The "0.1.11 vs 0.1.12-rc.1" case is the
// regression that broke `argus-sidecar update --prerelease` — GitHub's
// API returned 0.1.11 first in the listing, and the previous logic
// returned the first matching release without comparing versions.
func TestCompareVersion(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		// Regression case: a higher patch with a prerelease still beats
		// a lower stable patch.
		{"0.1.12-rc.1", "0.1.11", 1},
		{"0.1.11", "0.1.12-rc.1", -1},

		// Equal versions.
		{"1.2.3", "1.2.3", 0},
		{"1.2.3-rc.1", "1.2.3-rc.1", 0},

		// Stable > prerelease at same MAJOR.MINOR.PATCH.
		{"1.2.3", "1.2.3-rc.1", 1},
		{"1.2.3-rc.1", "1.2.3", -1},

		// Numeric prerelease ordering.
		{"1.0.0-rc.1", "1.0.0-rc.2", -1},
		{"1.0.0-rc.10", "1.0.0-rc.2", 1},

		// Main version dominates prerelease.
		{"2.0.0-rc.1", "1.99.99", 1},

		// SemVer §11.4: numeric IDs sort below alphanumeric.
		{"1.0.0-1", "1.0.0-alpha", -1},
		// Shorter prerelease list sorts below longer when prefix matches.
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
	}
	for _, tc := range cases {
		got := compareVersion(tc.a, tc.b)
		if got != tc.want {
			t.Errorf("compareVersion(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestIsValidVersion(t *testing.T) {
	valid := []string{"0.1.11", "0.1.12-rc.1", "10.20.30", "1.0.0-alpha.beta.1"}
	for _, v := range valid {
		if !isValidVersion(v) {
			t.Errorf("isValidVersion(%q) = false, want true", v)
		}
	}
	invalid := []string{"", "0.1", "0.1.x", "0.1.0-", "0.1.0-rc..1", "0.1.0+build.1"}
	for _, v := range invalid {
		if isValidVersion(v) {
			t.Errorf("isValidVersion(%q) = true, want false", v)
		}
	}
}
