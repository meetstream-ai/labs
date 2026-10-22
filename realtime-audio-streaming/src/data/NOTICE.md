# Third-party data

## english-spelling.json

British → American spelling pairs (1,739 entries), used by `src/wer.js` so a
spelling convention isn't scored as a recognition error.

- The list originally comes from the UK/US spelling list at tysto.com
  (https://web.archive.org/web/20230326222449/https://www.tysto.com/uk-us-spelling-list.html).
- This file is the `english.json` shipped by OpenAI's Whisper
  (https://github.com/openai/whisper, `whisper/normalizers/english.json`) and by
  `whisper-normalizer` 0.1.12, which `scripts/score_jiwer.py` also uses. Copied
  unchanged (sha256 `6607f948be9824d2…`).

Both are released under the MIT License:

```
Copyright (c) 2022 OpenAI
Copyright (c) 2023 Kurian Benoy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
