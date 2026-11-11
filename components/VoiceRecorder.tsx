"use client";

import { useState, useRef, useEffect } from "react";
import { Mic, Square, Trash2, Check } from "lucide-react";
import { useUI } from "./UIProvider";

interface VoiceRecorderProps {
  onRecorded: (blob: Blob, durationSeconds: number) => void;
  onCancel: () => void;
}

export default function VoiceRecorder({ onRecorded, onCancel }: VoiceRecorderProps) {
  const { showToast } = useUI();
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    startRecording();
    return () => {
      stopTracks();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function stopTracks() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      mediaRecorder.start(250); // Coleta a cada 250ms
      setIsRecording(true);

      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Permissão de microfone negada ou indisponível:", err);
      showToast("Não foi possível acessar o microfone.", "error");
      onCancel();
    }
  }

  function handleFinish() {
    if (!mediaRecorderRef.current || !isRecording) return;

    if (timerRef.current) clearInterval(timerRef.current);

    mediaRecorderRef.current.onstop = () => {
      const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
      stopTracks();
      onRecorded(audioBlob, duration);
    };

    mediaRecorderRef.current.stop();
    setIsRecording(false);
  }

  function handleDiscard() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
    }
    stopTracks();
    onCancel();
  }

  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;
  const timeFormatted = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  return (
    <div className="flex items-center gap-3 p-3 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded-xl">
      <div className="flex items-center gap-2">
        <span className="relative flex h-3 w-3">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500"></span>
        </span>
        <Mic className="w-4 h-4 text-red-500" />
      </div>

      <span className="text-sm font-mono font-medium text-red-700 dark:text-red-300">
        {timeFormatted}
      </span>

      <div className="flex-1 text-xs text-red-600 dark:text-red-400 italic">
        Gravando áudio Opus/WebM...
      </div>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={handleDiscard}
          title="Descartar gravação"
          className="p-1.5 text-slate-500 hover:text-red-600 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/40 transition"
        >
          <Trash2 className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={handleFinish}
          title="Salvar gravação"
          className="p-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition flex items-center gap-1 text-xs px-2.5 font-medium"
        >
          <Check className="w-4 h-4" />
          Concluir
        </button>
      </div>
    </div>
  );
}
