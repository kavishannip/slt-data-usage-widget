# SLT Usage Widget

An Electron-based desktop widget to monitor Sri Lanka Telecom data usage.

## Note on Security
This app uses your personal `Authorization` bearer token from MySLT. 
- The token is stored locally on your machine using `electron-store`.
- Do not commit your config files or share your built app if it contains your baked-in credentials.
- Keep your token private.
