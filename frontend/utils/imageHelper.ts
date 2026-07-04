// frontend/utils/imageHelper.ts

export const autoCropCenter = (imageFile: File): Promise<File> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.src = URL.createObjectURL(imageFile);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Define a bounding crop area (taking the center 60% helps ensure we don't cut off the pill)
      const cropWidth = img.width * 0.6;
      const cropHeight = img.height * 0.6;
      const startX = (img.width - cropWidth) / 2;
      const startY = (img.height - cropHeight) / 2;

      canvas.width = cropWidth;
      canvas.height = cropHeight;

      // Draw only the center chunk
      ctx?.drawImage(img, startX, startY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
      
      canvas.toBlob((blob) => {
        if (blob) {
          // Convert it back into a standard File object so your existing upload logic doesn't break
          const croppedFile = new File([blob], imageFile.name, {
            type: 'image/jpeg',
            lastModified: Date.now(),
          });
          resolve(croppedFile);
        }
      }, 'image/jpeg', 0.95);
    };
  });
};