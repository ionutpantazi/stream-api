# Stream API

A dependency-free Node.js proxy for configurable live radio streams.
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

## Station configuration

Edit [stations.json](./stations.json) to add or change stations:

```json
[
  {
    "id": "kissfm",
    "url": "https://live.kissfm.ro/kissfm.aacp",
    "icon": "kissfm.png"
  }
]
```

Each entry creates two GET endpoints:

- `/<id>` streams the station's configured URL.
- `/<id>/icon` returns the associated image from the [icons](./icons) folder
  with its image content type. For example, `/kissfm/icon` serves
  [kissfm.png](./icons/kissfm.png).

`GET /status` returns the complete configured station list as a JSON array
with each station's `id`, `url` and `icon`, using the same structure as
[stations.json](./stations.json). This lists the configuration; it does not
check upstream stream availability.

IDs must be unique and contain lowercase letters, digits or hyphens, starting
with a letter or digit. The ID `status` is reserved for the root status endpoint.
URLs must use HTTP or HTTPS. Icons must be filenames
(not paths); supported formats are PNG, JPEG, GIF, WebP, SVG, ICO and AVIF.
Restart the server after changing the configuration. Missing or unreadable
configured icons are logged and return HTTP 500.

Audio is streamed without buffering the entire response.
Each listener opens its own upstream connection, which is cancelled when
the listener disconnects. Upstream connection/header failures return HTTP 502
(with a 10-second header timeout); interruptions after streaming starts close
the connection. Other routes return 404 and unsupported methods return 405.

## Test

```powershell
npm test
```

Tests use a local upstream server and do not require the live radio station.
