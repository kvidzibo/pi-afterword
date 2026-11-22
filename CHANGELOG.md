# Changelog

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
