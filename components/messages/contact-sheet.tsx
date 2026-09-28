"use client";

import { useState } from "react";
import { CheckIcon } from "@/components/ios/icons";
import { Sheet, SheetAction, SheetDone, SheetGroup, SheetIdentity, SheetNote } from "./sheet";

type ContactSheetProps = { name: string | null; saved: boolean; onSave: () => void; onClose: () => void };

// The vCard preview iMessage opens from a shared contact. Saving is what makes the call ring by name.
export function ContactSheet({ name, saved, onSave, onClose }: ContactSheetProps) {
  return (
    <Sheet open={name !== null} onClose={onClose} label={`Contact card for ${name ?? "Persona"}`}>
      {name !== null && <ContactBody name={name} saved={saved} onSave={onSave} onClose={onClose} />}
    </Sheet>
  );
}

function ContactBody({ name, saved, onSave, onClose }: ContactSheetProps & { name: string }) {
  const [justSaved, setJustSaved] = useState(false);
  const save = () => {
    setJustSaved(true);
    onSave();
  };

  return (
    <>
      <SheetDone onClose={onClose} />
      <SheetIdentity name={name} />
      <SheetGroup>
        {saved || justSaved ? (
          <p role="status" className="flex min-h-48 items-center gap-8 px-16 text-ios-body text-ink">
            <CheckIcon className="size-18 text-ios-green" />
            Saved to contacts
          </p>
        ) : (
          <>
            <SheetAction onClick={save}>Create New Contact</SheetAction>
            <SheetAction onClick={save}>Add to Existing Contact</SheetAction>
          </>
        )}
      </SheetGroup>
      <SheetNote>Once saved, {name}’s calls ring by name, not as an unknown number.</SheetNote>
    </>
  );
}
