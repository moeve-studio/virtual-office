# Virtual Office v0.3

Version 0.3 bleibt auf demselben Strang wie v0.2 und repariert gezielt die Call-Logik, statt eine neue Parallelvariante aufzumachen.

## Neu gegenüber v0.2

- robusteres Aufräumen nach Call-Ende
- Mikrofon/Kamera werden nach Gesprächsende vollständig freigegeben
- neuer Call startet technisch sauber neu
- Button „Medien neu laden“ im aktiven Gespräch
- klarere Medienhinweise im Call-Panel
- vorsichtigeres Re-Joining bei Call-Updates
- weiterhin dieselbe Grundarchitektur wie v0.2

## Enthalten

- Hauptraum + Projekträume
- Eintritt / Verlassen
- Name ohne Login
- optionales Bild
- Status: anwesend / snooze / im Gespräch / abwesend
- Sichtbarkeit, wer in welchem Raum ist
- Sichtbarkeit, wer mit wem spricht
- Gruppenchat pro Raum
- Browserbasierte Audio/Video-Calls

## Noch nicht produktionsreif

- keine persistente Datenbank
- keine Authentifizierung
- keine Rollen / Moderation
- keine TURN-Server-Konfiguration für schwierige Netzwerke
- kein Deployment-Hardening
- kein mobiles Feintuning
- Chat-Historie nur im Arbeitsspeicher des Servers

## Start lokal

```bash
npm install
npm start
```

Dann im Browser öffnen:

```text
http://localhost:3000
```

## Wichtiger Test-Hinweis

Mikrofon sauber mit zwei echten Geräten testen. Zwei Tabs auf demselben Rechner sind für Audio nur bedingt aussagekräftig.

## Architektur

- `server.js` → Express + Socket.io
- `public/app.js` → UI, Präsenz, Chat, WebRTC-Signaling
- `public/styles.css` → Oberfläche
- `public/index.html` → App-Shell
