# Dokumentasi API & Kontrak gRPC - Word Duel

Dokumentasi ini menjelaskan arsitektur komunikasi, endpoint REST API, kontrak gRPC, dan protokol WebSocket yang digunakan dalam sistem terdistribusi **Word Duel**.

---

## 1. Arsitektur Infrastruktur & Gateway (Nginx)

Nginx bertindak sebagai **API Gateway** dan **Static File Server** pada port `8081` (diterjemahkan dari port kontainer `80`).

Berikut adalah pemetaan routing Nginx Gateway:

| Path URL Gateway | Layanan Tujuan (Internal Docker) | Deskripsi |
|---|---|---|
| `/` | Statis HTML/CSS/JS (`frontend/`) | Menyajikan file statis UI Game |
| `/api/auth/*` | `login-service:4001` (Load Balanced) | Pendaftaran dan Autentikasi Pengguna |
| `/api/users/*` | `user-service:4002` | Manajemen data profil pemain |
| `/api/matchmaking/*` | `matchmaking-service:4005` | Antrean tanding (Matchmaking) |
| `/api/leaderboard/*` | `ranking-service:4003` | Leaderboard Global |
| `/socket.io/*` | `chat-service:4004` (WebSocket Upgrade) | Aliran game real-time & chat |

---

## 2. Endpoint REST API

Semua endpoint REST (kecuali registrasi & login) memerlukan Header Autentikasi JWT:
```http
Authorization: Bearer <your_jwt_token>
```

### A. Login & Registrasi (`login-service`)

#### `POST /api/auth/register`
Mendaftarkan akun baru ke dalam sistem.
* **Request Body**:
  ```json
  {
    "username": "pemain_keren",
    "password": "rahasia_password"
  }
  ```
* **Response (201 Created)**:
  ```json
  {
    "id": "user_1781794339369_zrn4gia4m",
    "username": "pemain_keren"
  }
  ```

#### `POST /api/auth/login`
Melakukan login dan mendapatkan JWT Token.
* **Request Body**:
  ```json
  {
    "username": "pemain_keren",
    "password": "rahasia_password"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "message": "Login successful",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "userId": "user_1781794339369_zrn4gia4m"
  }
  ```

---

### B. User Service (`user-service`)

#### `GET /api/users/users/:id`
Mendapatkan statistik profil lengkap pengguna.
* **Response (200 OK)**:
  ```json
  {
    "id": "user_1781794339369_zrn4gia4m",
    "username": "pemain_keren",
    "elo": 1025,
    "wins": 3,
    "games": 5
  }
  ```

#### `POST /api/users/matches/complete` *(Internal Service / Protected)*
Memulai transaksi Saga ELO saat pertandingan selesai.
* **Request Body**:
  ```json
  {
    "matchId": "match_12345678",
    "winnerId": "user_winner_id",
    "loserId": "user_loser_id"
  }
  ```
* **Response (200 OK)**:
  ```json
  {
    "success": true,
    "matchId": "match_12345678",
    "winner": { "id": "user_winner_id", "elo": 1025 },
    "loser": { "id": "user_loser_id", "elo": 975 }
  }
  ```

---

### C. Matchmaking Service (`matchmaking-service`)

#### `POST /api/matchmaking/join`
Bergabung dengan antrean matchmaking. Menggunakan metode *Long Polling* (timeout hingga 90 detik).
* **Response (200 OK)**: (Dipancarkan saat lawan ditemukan)
  ```json
  {
    "matchId": "match_1781794339815",
    "opponentId": "user_opponent_id",
    "opponentUsername": "lawan_tanding",
    "opponentElo": 1000
  }
  ```

#### `POST /api/matchmaking/leave`
Membatalkan keikutsertaan dalam antrean matchmaking.
* **Response (200 OK)**:
  ```json
  {
    "message": "Left queue successfully"
  }
  ```

#### `GET /api/matchmaking/queue/status`
Mendapatkan total jumlah pemain aktif yang sedang mengantre saat ini.
* **Response (200 OK)**:
  ```json
  {
    "playersInQueue": 3
  }
  ```

---

### D. Ranking Service (`ranking-service`)

#### `GET /api/leaderboard/leaderboard`
Mendapatkan daftar 10 pemain teratas berdasarkan ELO terupdate dari Redis Cache.
* **Response (200 OK)**:
  ```json
  [
    { "rank": 1, "username": "alice", "elo": 1150 },
    { "rank": 2, "username": "pemain_keren", "elo": 1025 },
    { "rank": 3, "username": "bob", "elo": 975 }
  ]
  ```

---

## 3. Protokol Game Real-Time (WebSockets via `chat-service`)

Komunikasi real-time game dan live chat menggunakan protokol **Socket.io** yang berjalan di atas port `4004`. Autentikasi token JWT diproses langsung saat handshake.

### A. Event yang Dikirim Client (Client to Server)

#### `join_room`
Bergabung ke room pertandingan sesaat setelah matchmaking berhasil.
* **Payload**:
  ```json
  { "matchId": "match_1781794339815" }
  ```

#### `submit_guess`
Mengirim tebakan kata Wordle 5 huruf.
* **Payload**:
  ```json
  {
    "matchId": "match_1781794339815",
    "guess": "PLANT"
  }
  ```

#### `send_message`
Mengirim pesan chat real-time ke lawan.
* **Payload**:
  ```json
  {
    "matchId": "match_1781794339815",
    "message": "Semoga beruntung!"
  }
  ```

---

### B. Event yang Diterima Client (Server to Client)

#### `receive_message`
Menerima pesan chat dari lawan main.
* **Payload**:
  ```json
  {
    "sender": "lawan_tanding",
    "message": "Semoga beruntung!"
  }
  ```

#### `guess_result`
Broadcast hasil evaluasi tebakan Wordle (baik tebakan Anda maupun lawan).
* **Payload**:
  ```json
  {
    "userId": "user_some_id",
    "username": "pemain_keren",
    "guess": "PLANT",
    "feedback": "XYXXX"
  }
  ```
  *(Catatan: Feedback disusun dari 5 karakter: `G` = Correct/Hijau, `Y` = Present/Kuning, `X` = Absent/Abu-abu)*

#### `out_of_guesses`
Dipancarkan khusus ke pemain yang telah kehabisan 6 kesempatan menebak tetapi lawannya masih memiliki sisa tebakan. Client tidak memutus WebSocket dan masuk ke mode spectating.

#### `opponent_out_of_guesses`
Dipancarkan ke pemain aktif untuk mengabarkan bahwa lawannya sudah kehabisan kesempatan tebak.
* **Payload**:
  ```json
  { "username": "lawan_tanding" }
  ```

#### `game_over`
Dipancarkan ke room ketika permainan selesai (ada yang menang atau hasil seri/draw).
* **Payload**:
  ```json
  {
    "winnerId": "user_winner_id",
    "winnerUsername": "alice",
    "newWinnerElo": 1025,
    "newLoserElo": 975,
    "secretWord": "WORLD",
    "draw": false
  }
  ```

#### `opponent_disconnected`
Dipancarkan ke pemain jika lawan keluar/putus koneksi di tengah permainan.
* **Payload**:
  ```json
  { "username": "lawan_tanding" }
  ```

---

## 4. Kontrak gRPC (Komunikasi Antar Microservice)

Protokol gRPC digunakan untuk komunikasi cepat berlatensi rendah antar microservices di backend.

### A. Layanan Pengguna (`user.proto`)
Digunakan oleh `matchmaking-service` untuk menanyakan rating ELO pemain ke `user-service`.

* **Service Definition**:
  ```protobuf
  syntax = "proto3";

  package user;

  service UserService {
    rpc GetUserElo (UserEloRequest) returns (UserEloResponse);
  }

  message UserEloRequest {
    string userId = 1;
  }

  message UserEloResponse {
    string userId = 1;
    string username = 2;
    int32 elo = 3;
  }
  ```

### B. Layanan Matchmaking (`matchmaking.proto`)
Digunakan untuk interaksi internal matchmaking queue.

* **Service Definition**:
  ```protobuf
  syntax = "proto3";

  package matchmaking;

  service MatchmakingService {
    rpc JoinQueue (MatchRequest) returns (MatchResponse);
  }

  message MatchRequest {
    string userId = 1;
  }

  message MatchResponse {
    string matchId = 1;
    string opponentId = 2;
    string opponentUsername = 3;
    int32 opponentElo = 4;
  }
  ```
