# Changelog

## 0.13.0

- Remember which notes have been reviewed: `/pi-afterword` shows the reviewed marker and the number of newer notes, labels reviewed notes, and `r` sets the marker to any note ID or back to 0.

## 0.12.0

- Save each note's cost estimate, including shortening requests, and show it when the note is saved and in `/pi-afterword`; older notes show `unknown`.

## 0.11.0

- Ask the session's own model what it learned, as one more question on the session's request with its thinking level, so providers can reuse the prompt cache; the exchange is never added to the session. Done during a running agent turn is skipped, and a turn starting during generation interrupts it.
- Shorten an overlong note in the same conversation, asking for at most 20 words and then 15; the 30-word limit is unchanged.
- Save the session's thinking level with each note, and log each request's token usage and cost estimate.

## 0.10.0

- Ask the model to shorten a note over 30 words, up to two more times, instead of discarding it; the prompt now aims for 25 words.
- Name the failure category when a note is not saved, and log each generation's outcome, timings and word counts to the session file.

## 0.9.0

- Show when afterword generation starts and print the saved note after a successful write.

## 0.8.0

- Save an afterword from the outgoing conversation on interactive `/new`, with the same eligibility and deduplication as quit.

## 0.7.0

- Show each afterword's generating model and thinking level beside its ID and date, and in details.
- Save generation thinking levels; automatically upgrade existing databases, leaving older levels unknown.

## 0.6.0

- First standalone Pi package, extracted without behavior changes from the local extension.
- Save one lesson of at most 30 words on interactive quit or successful Pinote Done after at least 10 agent turns.
- Browse saved notes with `/pi-afterword`; show the saved-note count at interactive startup.
