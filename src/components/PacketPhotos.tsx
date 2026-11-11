import { useState } from "react";
import { addPhoto, deletePhoto } from "@/lib/actions";
import { photosFor } from "@/lib/garden";
import { useGarden } from "@/lib/GardenContext";
import type { Species } from "@/lib/types";
import { PhotoPicker, shrink } from "./forms";
import { Photo } from "./ui";

const SIDES = [
  { kind: "packet_front", label: "Front" },
  { kind: "packet_back", label: "Back" },
] as const;

/** The seed packet's front and back: tap a side to photograph it, or to replace the photo. */
export function PacketPhotos({ species }: { species: Species }) {
  const { data, act, today } = useGarden();
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (kind: (typeof SIDES)[number]["kind"], file: File) => {
    setBusy(kind);
    try {
      const blob = await shrink(file, 2000); // packet backs are small print; keep more detail
      const old = photosFor(data, { speciesId: species.id, kind });
      await act(async (ctx) => {
        for (const ph of old) await deletePhoto(ctx, ph.id);
        await addPhoto(ctx, { plantingId: null, speciesId: species.id, trayId: null, kind, caption: `Seed packet (${kind === "packet_front" ? "front" : "back"})`, takenAt: today }, blob);
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="packet-slots">
      {SIDES.map(({ kind, label }) => {
        const photo = photosFor(data, { speciesId: species.id, kind })[0];
        return (
          <div key={kind} className="packet-slot">
            {photo ? (
              <Photo id={photo.id} alt={`${species.commonName} packet ${label.toLowerCase()}`} className="packet" link />
            ) : <div className="packet packet-empty"><span style={{ fontSize: "1.6rem" }}>📷</span><span>Add packet {label.toLowerCase()}</span></div>}
            <span className="small muted">{label}</span>
            <PhotoPicker
              className="packet-photo-picker"
              previewClassName="photo-drop-preview"
              label={`${photo ? "Replace" : "Add"} packet ${label.toLowerCase()}`}
              buttonLabel={busy === kind ? "Saving…" : photo ? "Replace" : "Choose photo"}
              busy={busy === kind}
              onFile={(file) => void save(kind, file)}
            />
          </div>
        );
      })}
    </div>
  );
}
