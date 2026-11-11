"use client";

import { useState, useRef, useEffect } from "react";
import { Palette, Check } from "lucide-react";
import { NOTE_COLORS } from "@/types/note";

interface ColorPickerProps {
  selectedColor: string;
  onSelectColor: (color: string) => void;
}

export default function ColorPicker({ selectedColor, onSelectColor }: ColorPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        title="Alterar cor"
        className="p-1.5 text-slate-500 hover:text-slate-900 dark:hover:text-white hover:bg-black/5 dark:hover:bg-white/10 rounded-full transition"
      >
        <Palette className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute left-0 bottom-full mb-2 p-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl z-50 flex flex-wrap gap-1.5 w-44">
          {NOTE_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                onSelectColor(c.id);
                setIsOpen(false);
              }}
              title={c.name}
              className={`w-6 h-6 rounded-full border border-slate-300 dark:border-slate-600 flex items-center justify-center transition hover:scale-110 note-color-${c.id}`}
            >
              {selectedColor === c.id && (
                <Check className="w-3.5 h-3.5 text-slate-700 dark:text-slate-200" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
