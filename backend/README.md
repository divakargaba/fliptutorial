# Breakpoint backend

Local FastAPI server that serves approved exercises and grades Python code through Judge0.

## Setup

### macOS / Linux

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # fill in your keys
```

### Windows

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env   # fill in your keys
```

## Run

### macOS / Linux

```sh
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env
```

### Windows

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env
```

## Test

```sh
# macOS / Linux
.venv/bin/python -m pytest -q

# Windows
.\.venv\Scripts\python.exe -m pytest -q
```

Default tests run without provider keys. A live Judge0 smoke test is skipped unless
`JUDGE0_BASE_URL` is set in the environment.
