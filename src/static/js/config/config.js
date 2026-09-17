export const CONFIG = {
    API: {
        VERSION: 'v1beta',
        // Service version used in the Live API WebSocket path
        // (.../ws/google.ai.generativelanguage.<WS_API_VERSION>...).
        // v1beta is the current default (@google/genai SDK >= 2.x);
        // v1alpha is legacy (only needed for experimental ephemeral tokens).
        WS_API_VERSION: 'v1beta',
        // Default model for the Live API (WebSocket). Google only accepts
        // "-live" models for bidiGenerateContent (as of 2026-09:
        // gemini-3.8-live / gemini-3.8-live-extended-thinking /
        // gemini-3.1-flash-live-preview). Plain REST models (e.g.
        // gemini-3.6-flash) have no live variant — they only work via the
        // /v1/chat/completions proxy.
        MODEL_NAME: 'models/gemini-3.8-live',
        // Fallback candidates used to populate the model dropdown when
        // fetching /v1/models fails (e.g. no API key entered yet).
        MODEL_LIST_FALLBACK: [
            'models/gemini-3.8-live',
            'models/gemini-3.8-live-extended-thinking',
            'models/gemini-3.1-flash-live-preview',
            'models/gemini-3.6-flash',
            'models/gemini-2.5-flash',
            'models/gemini-2.5-pro',
        ]
    },
    // You can change the system instruction to your liking
    SYSTEM_INSTRUCTION: {
        TEXT: 'You are my helpful assistant. You can see and hear me, and respond with voice and text. If you are asked about things you do not know, you can use the google search tool to find the answer.',
    },
    // Default audio settings
    AUDIO: {
        SAMPLE_RATE: 16000,
        OUTPUT_SAMPLE_RATE: 24000,      // If you want to have fun, set this to around 14000 (u certainly will)
        BUFFER_SIZE: 2048,
        CHANNELS: 1
    },
    // If you are working in the RoArm branch 
    // ROARM: {
    //     IP_ADDRESS: '192.168.1.4'
    // }
  };
  
  export default CONFIG; 