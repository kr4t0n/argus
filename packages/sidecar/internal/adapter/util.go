package adapter

import "encoding/json"

// marshal is a thin wrapper that returns a string and error, used by several
// adapters when building meta blobs or normalizing unknown content shapes.
func marshal(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
