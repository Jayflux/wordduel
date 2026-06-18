# Word Duel — Multiplayer Wordle Battle

Word Duel adalah game duel tebak kata Wordle real-time berbasis sistem terdistribusi mikroservis (*microservices*). Proyek ini dirancang menggunakan berbagai teknologi modern untuk menjamin performa latensi rendah, skalabilitas, dan konsistensi data.

---

## 🚀 Fitur Utama

1. **Dual Papan Wordle Real-Time**: Tebak kata 5 huruf bersamaan dengan lawan main secara langsung. Anda dapat melihat progres tebakan lawan di layar Anda secara live.
2. **Matchmaking Berbasis ELO**: Pencarian lawan otomatis menggunakan algoritma pencocokan tingkat keterampilan (rating ELO) dengan jangkauan pencarian (*ELO window*) yang meluas setiap beberapa detik.
3. **Live Chat**: Mengobrol secara langsung dengan lawan main di tengah pertandingan.
4. **Leaderboard Global**: Menampilkan peringkat 10 pemain teratas secara real-time yang didukung oleh Redis Cache.
5. **Fault Tolerance (Failover)**: Nginx API Gateway secara otomatis membagi trafik login dan menangani failover aktif-aktif ke server cadangan jika salah satu instance *login-service* tidak aktif.
6. **Saga Transaction Pattern**: Mengatur transaksi ELO Saga saat game berakhir untuk menjamin konsistensi data antara database PostgreSQL (Profil) dan Redis Cache (Leaderboard), lengkap dengan penanganan pembatalan (*rollback*) otomatis jika salah satu proses gagal.

---

## 🛠️ Arsitektur & Teknologi

* **Frontend**: HTML5, Vanilla CSS (Modern Glassmorphism Theme), JavaScript (Socket.io Client).
* **API Gateway & Static Server**: Nginx (Load Balancing, SSL Termination, Static File Server).
* **Autentikasi**: JWT (JSON Web Tokens) via `login-service`.
* **Database Relasional**: PostgreSQL dengan arsitektur Master-Slave Replication.
* **Cache & Leaderboard**: Redis (Sorted Sets).
* **Komunikasi Antar Microservice**: gRPC (Google Protocol Buffers).
* **WebSocket Server**: Socket.io (Node.js) di `chat-service`.

---

## 📦 Cara Menjalankan Game Secara Lokal (Docker Desktop)

Seluruh sistem Word Duel telah dikontainerisasi penuh menggunakan Docker. Anda atau teman Anda dapat menjalankan game ini di komputer masing-masing tanpa perlu menginstal database atau library Node.js secara manual.

### 1. Prasyarat
Pastikan komputer Anda sudah terpasang **Docker Desktop** dan aplikasinya sudah dalam posisi menyala:
👉 [Download Docker Desktop](https://www.docker.com/products/docker-desktop/)

### 2. Langkah-langkah
1. Kloning repositori ini ke komputer Anda:
   ```bash
   git clone https://github.com/Jayflux/wordduel.git
   cd wordduel
   ```
2. Jalankan seluruh kontainer microservices menggunakan Docker Compose:
   ```bash
   docker compose up -d --build
   ```
3. Tunggu hingga proses build selesai dan semua status container bertuliskan **Started/Healthy**.

### 3. Cara Menguji Coba
1. Buka browser Anda dan akses alamat:
   👉 **`http://localhost:8081`**
2. Untuk mensimulasikan pertempuran berdua di satu komputer:
   - Buka **satu tab browser biasa** dan masuk (*login*) menggunakan akun pertama.
   - Buka **satu tab browser Incognito (Penyamaran)** dan masuk menggunakan akun kedua.
   - Tekan tombol **Cari Tanding (Find Match)** pada kedua tab tersebut secara bersamaan untuk dipertemukan dalam satu arena game.

---

## 📖 Dokumentasi API & gRPC

Untuk penjelasan lengkap mengenai pemetaan routing Nginx, format request-response REST API, event WebSocket yang dipancarkan oleh *chat-service*, serta file `.proto` gRPC, silakan baca berkas dokumentasi berikut:
👉 [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
