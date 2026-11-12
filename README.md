# Stream API

A dependency-free Node.js proxy for the Kiss FM live audio stream.
Requires Node.js 22 or later.

## Run

```powershell
npm start
```

Open `http://localhost:3000/kissfm` in an audio player or browser:

```html
<audio controls src="http://localhost:3000/kissfm"></audio>
```

To select another port in PowerShell:

```powershell
$env:PORT = "8080"
npm start
```

`GET /kissfm` streams audio from
`https://live.kissfm.ro/kissfm.aacp` without buffering the entire response.
Each listener opens its own upstream connection, which is cancelled when
the listener disconnects. Upstream connection/header failures return HTTP 502
(with a 10-second header timeout); interruptions after streaming starts close
the connection. Other routes return 404 and unsupported methods return 405.

## Test

```powershell
npm test
```

Tests use a local upstream server and do not require the live radio station.
