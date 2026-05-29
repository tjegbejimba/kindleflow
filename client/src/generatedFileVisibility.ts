export interface GeneratedFileForVisibility {
  filename: string;
  mimeType: "application/epub+zip" | "application/pdf";
  downloadUrl: string;
  sentToKindle: boolean;
}

export function visibleGeneratedFileAfterDelivery<T extends GeneratedFileForVisibility>(file: T): T | null {
  if (file.mimeType === "application/epub+zip" && file.sentToKindle) {
    return null;
  }

  return file;
}
