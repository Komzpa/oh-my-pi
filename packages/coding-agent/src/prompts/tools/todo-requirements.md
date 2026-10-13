Requirement audits use the exact assigned IDs, one row per requirement; NEVER append letter suffixes or invent split IDs.

Classify requirement candidates with op="classify": id is the Rn, classification is linked (needs rows with exact todo row contents), not-a-requirement (needs reason), or merged (needs mergeInto with another Rn). Example: op="classify", id="R1", classification="linked", rows=["<exact todo row>"].
