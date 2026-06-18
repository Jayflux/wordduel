# Word Duel Backend

Proyek backend game multiplayer Word Duel menggunakan arsitektur microservices terdistribusi.

## Struktur Direktori
* `/proto` : Definisi gRPC Protocol Buffers
* `/login-service` : Autentikasi dan sesi menggunakan JWT
* `/user-service` : Manajemen profil pemain dan penyimpanan database ELO
* `/matchmaking-service` : Antrean pencarian lawan berbasis ELO via gRPC
