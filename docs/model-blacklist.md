# Owner model blacklist

Put exact `provider/model-id` keys and a reason for each ban in
`~/.omp/model-blacklist.json`:

```json
{
	"example-provider/example-model": "Fabricated verification results; owner approval required to restore"
}
```

This file is shared by every profile. Provider names must be lowercase; model
IDs are exact and may contain slashes. A ban removes the model from registry
lookups and selection. Adding it back to a custom catalog, role pool, preset or
fallback list does not override the ban: both chat dispatch entry points check
the file again before contacting the provider, including for already selected
or resumed models.

Explicit banned model requests MUST fail with the identity and policy reason
before fuzzy matching, thinking-selector parsing or default/override fallback.
This includes separate CLI provider/model flags and qualified selectors whose
model IDs contain slashes or literal suffixes such as `:free`.
Role aliases, ordered role/retry candidates, scope globs and automatic defaults
MUST exclude banned identities, including cached candidates, and may continue
only to permitted candidates. A banned exact role candidate MUST NOT fuzzy-match
a neighboring model; exhausted candidates use the existing no-model path.

The file is read on every lookup and dispatch, so no restart is needed for policy
changes in a process running this version. Malformed JSON, invalid selectors and
blank reasons stop lookup/dispatch with an error. A missing file means no bans.
Write updates atomically to avoid exposing partially written JSON. Removing an
entry explicitly lifts that ban. This is an owner policy, not a sandbox against
code that can edit the policy file or call provider implementations directly.
