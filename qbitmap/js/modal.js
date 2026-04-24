import { viewTransition } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {
    // ================= MODAL FONKSİYONLARI BAŞLANGIÇ =================

    // HTML elementlerini seç
    const modal = document.getElementById("imageModal");
    if (!modal) return; // Modal yoksa devam etme

    const modalImg = document.getElementById("modalImage");
    const captionText = document.getElementById("caption");
    const closeButton = document.querySelector("#imageModal .close");

    // Bu fonksiyon, dışarıdan çağrılarak modal'ı açmak için kullanılacak.
    // Örneğin, cameras-settings.js dosyasından.
    const openImageModal = function(imageUrl, imageCaption = "Kamera Görüntüsü") {
        viewTransition(() => {
            modal.style.display = "block"; // Modalı görünür yap
            modalImg.src = imageUrl; // Resim kaynağını ayarla
            captionText.textContent = imageCaption; // Başlık ekle (XSS koruması için textContent)
        });
    }

    // Kapatma fonksiyonu
    const closeModal = function() {
        viewTransition(() => {
            modal.style.display = "none";
            modalImg.src = ""; // Hafızayı boşaltmak için resmi temizle
        });
    }

    // Kapatma (X) butonuna tıklanınca modalı kapat
    if(closeButton) {
        closeButton.onclick = closeModal;
    }

    // Modal açıkken pencerenin dışına tıklanınca da kapat
    window.addEventListener('click', function(event) {
        if (event.target == modal) {
            closeModal();
        }
    });

    // ESC tuşuna basıldığında modalı kapat
    document.addEventListener('keydown', function(event) {
        if (event.key === "Escape" && modal.style.display === "block") {
            closeModal();
        }
    });

    // ================== MODAL FONKSİYONLARI BİTİŞ ==================
});

export {};