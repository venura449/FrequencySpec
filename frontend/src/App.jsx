import { useEffect, useRef, useState } from 'react'
import './App.css'

function App() {
  const spectrogramRef = useRef(null)
  const waveformRef = useRef(null)
  const spectrumRef = useRef(null)
  const fileInputRef = useRef(null)
  const [isListening, setIsListening] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [isReplaying, setIsReplaying] = useState(false)
  const [recordings, setRecordings] = useState([])
  const [showRecordings, setShowRecordings] = useState(true)
  const [nyquistHz, setNyquistHz] = useState(20000)
  const [hoverFreqHz, setHoverFreqHz] = useState(null)
  const [useLogScale, setUseLogScale] = useState(true) // Logarithmic scale by default (like Maztr)
  const [topResonatingFreq, setTopResonatingFreq] = useState(null)
  const [harmonyInfo, setHarmonyInfo] = useState(null) // { fundamental, harmonics: [] }
  const [error, setError] = useState('')

  const recordedFramesRef = useRef([])
  const recordingStartRef = useRef(null)
  const replayRequestIdRef = useRef(null)
  const isRecordingRef = useRef(false)
  const nyquistRef = useRef(20000)
  const sampleRateRef = useRef(44100)
  const fftSizeRef = useRef(2048)
  const bufferLengthRef = useRef(1024)

  // Helper: Map bin index to Y position (linear or logarithmic)
  // Frequency range: 5 Hz to 20000 Hz
  const binToY = (binIndex, bufferLength, height, logarithmic, sampleRate, fftSize) => {
    const minFreq = 5
    const maxFreq = 20000
    const binFreq = (binIndex * sampleRate) / fftSize
    
    // Only map bins in the 5-20000 Hz range
    if (binFreq < minFreq || binFreq > maxFreq) {
      return -1 // Out of range, don't draw
    }
    
    if (logarithmic) {
      // Logarithmic scale: map frequency to log space
      const logMin = Math.log10(minFreq)
      const logMax = Math.log10(maxFreq)
      const logFreq = Math.log10(binFreq)
      const frac = 1 - (logFreq - logMin) / (logMax - logMin)
      return Math.floor(frac * (height - 1))
    } else {
      // Linear scale: map frequency linearly
      const frac = 1 - (binFreq - minFreq) / (maxFreq - minFreq)
      return Math.floor(frac * (height - 1))
    }
  }

  // Helper: Map Y position back to frequency (reverse of binToY)
  // Frequency range: 5 Hz to 20000 Hz
  const yToFreq = (y, height, logarithmic) => {
    const minFreq = 5
    const maxFreq = 20000
    
    if (logarithmic) {
      const logMin = Math.log10(minFreq)
      const logMax = Math.log10(maxFreq)
      const frac = 1 - (y + 0.5) / (height - 1)
      const logFreq = logMin + frac * (logMax - logMin)
      return Math.pow(10, logFreq)
    } else {
      const frac = 1 - (y + 0.5) / (height - 1)
      return minFreq + frac * (maxFreq - minFreq)
    }
  }
  
  // Helper: Convert frequency to bin index
  const freqToBin = (freq, sampleRate, fftSize) => {
    return Math.floor((freq * fftSize) / sampleRate)
  }

  // Helper: Calculate top resonating frequency and harmony
  const calculateFrequencyAnalysis = (freqDataArray, sampleRate, fftSize) => {
    if (!freqDataArray || freqDataArray.length === 0) return null

    // Find peak frequency (top resonating)
    let maxValue = 0
    let peakBin = 0
    for (let i = 0; i < freqDataArray.length; i += 1) {
      if (freqDataArray[i] > maxValue) {
        maxValue = freqDataArray[i]
        peakBin = i
      }
    }
    const peakFreq = (peakBin * sampleRate) / fftSize

    // Find fundamental frequency (lowest significant peak)
    // Look for peaks in lower frequency range (below 2kHz typically for elephant calls)
    const lowFreqLimit = Math.floor((2000 * fftSize) / sampleRate)
    let fundamentalBin = 0
    let fundamentalValue = 0
    
    for (let i = 1; i < Math.min(lowFreqLimit, freqDataArray.length); i += 1) {
      const value = freqDataArray[i]
      // Check if this is a local peak
      if (value > fundamentalValue && value > 50) { // Threshold to avoid noise
        const isPeak = (i === 0 || freqDataArray[i - 1] < value) &&
                       (i === freqDataArray.length - 1 || freqDataArray[i + 1] < value)
        if (isPeak) {
          fundamentalValue = value
          fundamentalBin = i
        }
      }
    }

    const fundamentalFreq = (fundamentalBin * sampleRate) / fftSize

    // Find harmonics (multiples of fundamental)
    const harmonics = []
    if (fundamentalFreq > 10) { // Only if we found a valid fundamental
      for (let n = 2; n <= 4; n += 1) {
        const harmonicFreq = fundamentalFreq * n
        const harmonicBin = Math.floor((harmonicFreq * fftSize) / sampleRate)
        if (harmonicBin < freqDataArray.length) {
          const harmonicValue = freqDataArray[harmonicBin]
          if (harmonicValue > 30) { // Threshold
            harmonics.push({
              order: n,
              frequency: harmonicFreq,
              amplitude: harmonicValue,
            })
          }
        }
      }
    }

    return {
      topResonating: peakFreq,
      fundamental: fundamentalFreq > 10 ? fundamentalFreq : null,
      harmonics,
    }
  }

  // Helper: Draw grid overlay on spectrogram
  const drawSpectrogramGrid = (ctx, width, height, bufferLength, useLog) => {
    ctx.save()
    ctx.strokeStyle = 'rgba(255, 152, 0, 0.3)' // Original orange grid lines, semi-transparent
    ctx.lineWidth = 1

    // Draw horizontal grid lines (frequency markers)
    // Use the same positions as legend labels
    const freqPositions = [1, 0.75, 0.5, 0.35, 0.2, 0] // Top to bottom
    freqPositions.forEach((p) => {
      const y = p * (height - 1)
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    })

    // Draw vertical grid lines (time markers)
    // Draw lines at regular intervals across the width
    const timeIntervals = 10 // Number of vertical grid lines
    for (let i = 0; i <= timeIntervals; i += 1) {
      const x = (i / timeIntervals) * width
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, height)
      ctx.stroke()
    }

    // Draw axis labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)' // Original white
    ctx.font = '12px system-ui, sans-serif'
    
    // Y-axis label: Frequency (kHz) - rotated on left side
    ctx.save()
    ctx.translate(15, height / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Frequency (kHz)', 0, 0)
    ctx.restore()
    
    // X-axis label: Time (s)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('Time (s)', width / 2, height - 20)
    
    // Draw time tick labels
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)' // Original white
    ctx.font = '10px system-ui, sans-serif'
    for (let i = 0; i <= timeIntervals; i += 1) {
      const x = (i / timeIntervals) * width
      const timeValue = i // Grid markers for visual reference
      ctx.fillText(`${timeValue}`, x, height - 8)
    }

    ctx.restore()
  }

  // Load saved recordings from localStorage on first mount
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('venura-frequency-recordings')
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setRecordings(parsed)
        }
      }
    } catch (e) {
      console.error('Failed to load recordings from localStorage', e)
    }
  }, [])

  // Persist recordings to localStorage whenever they change
  useEffect(() => {
    try {
      window.localStorage.setItem('venura-frequency-recordings', JSON.stringify(recordings))
    } catch (e) {
      console.error('Failed to save recordings to localStorage', e)
    }
  }, [recordings])

  useEffect(() => {
    if (isReplaying) {
      return undefined
    }

    let audioContext
    let analyser
    let source
    let animationFrameId
    let freqDataArray
    let timeDomainArray

    const start = async () => {
      try {
        setError('')
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        })

        audioContext = new (window.AudioContext || window.webkitAudioContext)()
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.8

        const sampleRate = audioContext.sampleRate || 44100
        const fftSize = analyser.fftSize
        const nyquist = Math.min(20000, sampleRate / 2)
        setNyquistHz(nyquist)
        nyquistRef.current = nyquist
        sampleRateRef.current = sampleRate
        fftSizeRef.current = fftSize

        source = audioContext.createMediaStreamSource(stream)
        source.connect(analyser)

        const bufferLength = analyser.frequencyBinCount
        bufferLengthRef.current = bufferLength
        freqDataArray = new Uint8Array(bufferLength)
        timeDomainArray = new Uint8Array(analyser.fftSize)

        const spectrogramCanvas = spectrogramRef.current
        const waveformCanvas = waveformRef.current
        const spectrumCanvas = spectrumRef.current

        const spectrogramCtx = spectrogramCanvas?.getContext('2d')
        const waveformCtx = waveformCanvas?.getContext('2d')
        const spectrumCtx = spectrumCanvas?.getContext('2d')

        const draw = () => {
          if (!spectrogramCtx || !spectrogramCanvas) return

          // Frequency data for spectrogram & spectrum
          analyser.getByteFrequencyData(freqDataArray)
          // Time-domain data for waveform
          analyser.getByteTimeDomainData(timeDomainArray)

          // ----- Spectrogram (waterfall) -----
          const specWidth = spectrogramCanvas.width
          const specHeight = spectrogramCanvas.height
          const imageData = spectrogramCtx.getImageData(1, 0, specWidth - 1, specHeight)
          spectrogramCtx.putImageData(imageData, 0, 0)

          // Calculate frequency analysis
          const analysis = calculateFrequencyAnalysis(freqDataArray, sampleRate, fftSize)
          if (analysis) {
            setTopResonatingFreq(analysis.topResonating)
            setHarmonyInfo({
              fundamental: analysis.fundamental,
              harmonics: analysis.harmonics,
            })
          }

          const barX = specWidth - 1
          for (let i = 0; i < bufferLength; i += 1) {
            const value = freqDataArray[i] / 255 // 0..1
            const y = binToY(i, bufferLength, specHeight, useLogScale, sampleRate, fftSize)
            
            // Skip if out of 5-20000 Hz range
            if (y < 0) continue

            // Original color mapping: dark background with purple/blue and some orange
            const intensity = value
            const r = Math.floor(255 * Math.pow(intensity, 3)) // more orange at high intensity
            const g = Math.floor(50 * intensity)
            const b = Math.floor(255 * Math.sqrt(intensity))

            spectrogramCtx.fillStyle = `rgb(${r}, ${g}, ${b})`
            spectrogramCtx.fillRect(barX, y, 1, 1)
          }

          // ----- Save frame if recording -----
          if (isRecordingRef.current) {
            const now = performance.now()
            if (recordingStartRef.current == null) {
              recordingStartRef.current = now
              recordedFramesRef.current = []
            }
            recordedFramesRef.current.push({
              t: now - recordingStartRef.current,
              freq: Array.from(freqDataArray),
              timeDomain: Array.from(timeDomainArray),
            })
          }

          // ----- Waveform (oscilloscope) -----
          if (waveformCtx && waveformCanvas) {
            const w = waveformCanvas.width
            const h = waveformCanvas.height
            waveformCtx.fillStyle = '#000'
            waveformCtx.fillRect(0, 0, w, h)

            waveformCtx.lineWidth = 2
            waveformCtx.strokeStyle = '#4caf50'
            waveformCtx.beginPath()

            const sliceWidth = w / timeDomainArray.length
            let x = 0
            for (let i = 0; i < timeDomainArray.length; i += 1) {
              const v = timeDomainArray[i] / 128.0 // around 1 at midline
              const y = (v / 2) * h
              if (i === 0) {
                waveformCtx.moveTo(x, y)
              } else {
                waveformCtx.lineTo(x, y)
              }
              x += sliceWidth
            }
            waveformCtx.stroke()
          }

          // ----- Instantaneous spectrum (FFT line plot) -----
          if (spectrumCtx && spectrumCanvas) {
            const w = spectrumCanvas.width
            const h = spectrumCanvas.height
            spectrumCtx.fillStyle = '#000'
            spectrumCtx.fillRect(0, 0, w, h)

            spectrumCtx.lineWidth = 2
            spectrumCtx.strokeStyle = '#ff9800' // Original orange
            spectrumCtx.beginPath()

            const step = Math.ceil(bufferLength / w)
            let x = 0
            for (let i = 0; i < bufferLength; i += step) {
              const value = freqDataArray[i] / 255
              const y = h - value * h
              if (x === 0) {
                spectrumCtx.moveTo(x, y)
              } else {
                spectrumCtx.lineTo(x, y)
              }
              x += 1
            }
            spectrumCtx.stroke()
          }

          animationFrameId = requestAnimationFrame(draw)
        }

        // Clear canvases once before starting
        if (spectrogramCtx && spectrogramCanvas) {
          spectrogramCtx.fillStyle = 'black'
          spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height)
        }
        if (waveformCtx && waveformCanvas) {
          waveformCtx.fillStyle = 'black'
          waveformCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height)
        }
        if (spectrumCtx && spectrumCanvas) {
          spectrumCtx.fillStyle = 'black'
          spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height)
        }

        setIsListening(true)
        draw()
      } catch (err) {
        console.error(err)
        setError('Could not access microphone. Please allow mic permission in your browser.')
        setIsListening(false)
      }
    }

    if (!isListening) {
      start()
    }

    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId)
      if (source) source.disconnect()
      if (analyser) analyser.disconnect()
      if (audioContext) audioContext.close()
    }
  }, [isListening, isReplaying, useLogScale])

  // Replay previously recorded frames onto the canvases
  useEffect(() => {
    if (!isReplaying) return undefined
    const frames = recordedFramesRef.current
    if (!frames.length) {
      setIsReplaying(false)
      return undefined
    }

    const spectrogramCanvas = spectrogramRef.current
    const waveformCanvas = waveformRef.current
    const spectrumCanvas = spectrumRef.current
    const spectrogramCtx = spectrogramCanvas?.getContext('2d')
    const waveformCtx = waveformCanvas?.getContext('2d')
    const spectrumCtx = spectrumCanvas?.getContext('2d')

    if (!spectrogramCtx || !spectrogramCanvas) {
      setIsReplaying(false)
      return undefined
    }

    const startTime = performance.now()

    // Initialize spectrogram canvas to black once before replay
    if (spectrogramCtx && spectrogramCanvas) {
      spectrogramCtx.fillStyle = 'black'
      spectrogramCtx.fillRect(0, 0, spectrogramCanvas.width, spectrogramCanvas.height)
    }

    const drawReplay = () => {
      const elapsed = performance.now() - startTime
      // Find frame with closest timestamp
      let frame = frames[frames.length - 1]
      for (let i = 0; i < frames.length; i += 1) {
        if (frames[i].t >= elapsed) {
          frame = frames[i]
          break
        }
      }

      const { freq, timeDomain } = frame

      const freqDataArray = Uint8Array.from(freq)
      const timeDomainArray = Uint8Array.from(timeDomain)

      const bufferLength = freqDataArray.length
      const sampleRate = sampleRateRef.current || 44100
      const fftSize = fftSizeRef.current || 2048

      // Spectrogram: scroll left and draw a new 1px column, same as live view
      const specWidth = spectrogramCanvas.width
      const specHeight = spectrogramCanvas.height
      const imageData = spectrogramCtx.getImageData(1, 0, specWidth - 1, specHeight)
      spectrogramCtx.putImageData(imageData, 0, 0)

      // Calculate frequency analysis for replay
      const analysis = calculateFrequencyAnalysis(freqDataArray, sampleRate, fftSize)
      if (analysis) {
        setTopResonatingFreq(analysis.topResonating)
        setHarmonyInfo({
          fundamental: analysis.fundamental,
          harmonics: analysis.harmonics,
        })
      }

      const barX = specWidth - 1
      for (let i = 0; i < bufferLength; i += 1) {
        const value = freqDataArray[i] / 255
        const y = binToY(i, bufferLength, specHeight, useLogScale, sampleRate, fftSize)
        
        // Skip if out of 5-20000 Hz range
        if (y < 0) continue
        
        // Original color mapping: dark background with purple/blue and some orange
        const intensity = value
        const r = Math.floor(255 * Math.pow(intensity, 3))
        const g = Math.floor(50 * intensity)
        const b = Math.floor(255 * Math.sqrt(intensity))
        
        spectrogramCtx.fillStyle = `rgb(${r}, ${g}, ${b})`
        spectrogramCtx.fillRect(barX, y, 1, 1)
      }

      // Waveform
      if (waveformCtx && waveformCanvas) {
        const w = waveformCanvas.width
        const h = waveformCanvas.height
        waveformCtx.fillStyle = '#000'
        waveformCtx.fillRect(0, 0, w, h)
        waveformCtx.lineWidth = 2
        waveformCtx.strokeStyle = '#4caf50'
        waveformCtx.beginPath()
        const sliceWidth = w / timeDomainArray.length
        let x = 0
        for (let i = 0; i < timeDomainArray.length; i += 1) {
          const v = timeDomainArray[i] / 128.0
          const y = (v / 2) * h
          if (i === 0) waveformCtx.moveTo(x, y)
          else waveformCtx.lineTo(x, y)
          x += sliceWidth
        }
        waveformCtx.stroke()
      }

      // Spectrum
      if (spectrumCtx && spectrumCanvas) {
        const w = spectrumCanvas.width
        const h = spectrumCanvas.height
        spectrumCtx.fillStyle = '#000'
        spectrumCtx.fillRect(0, 0, w, h)
        spectrumCtx.lineWidth = 2
        spectrumCtx.strokeStyle = '#ff9800'
        spectrumCtx.beginPath()
        const step = Math.ceil(bufferLength / w)
        let x = 0
        for (let i = 0; i < bufferLength; i += step) {
          const value = freqDataArray[i] / 255
          const y = h - value * h
          if (x === 0) spectrumCtx.moveTo(x, y)
          else spectrumCtx.lineTo(x, y)
          x += 1
        }
        spectrumCtx.stroke()
      }

      // Continue until we reach the final frame time
      if (elapsed <= frames[frames.length - 1].t && isReplaying) {
        replayRequestIdRef.current = requestAnimationFrame(drawReplay)
      } else {
        setIsReplaying(false)
      }
    }

    replayRequestIdRef.current = requestAnimationFrame(drawReplay)

    return () => {
      if (replayRequestIdRef.current) {
        cancelAnimationFrame(replayRequestIdRef.current)
      }
    }
  }, [isReplaying, useLogScale])

  const handleToggleRecording = () => {
    if (isReplaying) return

    // Starting a new recording
    if (!isRecordingRef.current) {
      recordingStartRef.current = null
      recordedFramesRef.current = []
      setIsRecording(true)
      isRecordingRef.current = true
      return
    }

    // Stopping current recording and saving it
    setIsRecording(false)
    isRecordingRef.current = false
    const frames = recordedFramesRef.current
    if (frames && frames.length) {
      const durationMs = frames[frames.length - 1].t
      const createdAt = new Date()

      setRecordings((prev) => {
        const index = prev.length + 1
        return [
          {
            id: `${createdAt.getTime()}-${index}`,
            label: `Recording ${index}`,
            createdAt: createdAt.toLocaleTimeString(),
            durationMs,
            nyquistHz: nyquistRef.current,
            sampleRate: sampleRateRef.current,
            fftSize: fftSizeRef.current,
            bufferLength: bufferLengthRef.current,
            frames: [...frames],
          },
          ...prev,
        ]
      })
    }
  }

  const handleSpectrogramHover = (event) => {
    const canvas = spectrogramRef.current
    if (!canvas) return
    // Use canvas pixel coordinates to avoid CSS scaling offset
    const { offsetY } = event.nativeEvent
    const height = canvas.height || 1
    const clampedY = Math.min(Math.max(offsetY, 0), height - 1)
    
    if (height - 1 <= 0) {
      setHoverFreqHz(null)
      return
    }
    
    // Map Y position directly to frequency (5-20000 Hz range)
    const freq = yToFreq(clampedY, height, useLogScale)
    setHoverFreqHz(Math.max(5, Math.min(20000, freq)))
  }

  const handleSpectrumHover = (event) => {
    const canvas = spectrumRef.current
    if (!canvas) return
    const { offsetX } = event.nativeEvent
    const width = canvas.width || 1
    const clampedX = Math.min(Math.max(offsetX, 0), width - 1)
    
    const bufferLength = bufferLengthRef.current || 1024
    const sampleRate = sampleRateRef.current || 44100
    const fftSize = fftSizeRef.current || 2048
    
    // FFT plot drawing: step = Math.ceil(bufferLength / width)
    // Loop: for (let i = 0; i < bufferLength; i += step) { draw at x, x++ }
    // So at pixel x, bin index = x * step (clamped to < bufferLength)
    const step = Math.ceil(bufferLength / width)
    const pixelIndex = Math.round(clampedX)
    const binIndex = Math.min(bufferLength - 1, pixelIndex * step)
    
    // Calculate frequency: bin i represents frequency range [i*SR/FFT, (i+1)*SR/FFT)
    // Use center frequency: (i + 0.5) * sampleRate / fftSize
    const freq = ((binIndex + 0.5) * sampleRate) / fftSize
    setHoverFreqHz(Math.max(0, Math.min(20000, freq)))
  }

  const handleReplay = (recordingId) => {
    const recording = recordings.find((r) => r.id === recordingId)
    if (!recording) return
    recordedFramesRef.current = recording.frames
    if (recording.nyquistHz) {
      nyquistRef.current = recording.nyquistHz
      setNyquistHz(recording.nyquistHz)
    }
    if (recording.sampleRate) {
      sampleRateRef.current = recording.sampleRate
    }
    if (recording.fftSize) {
      fftSizeRef.current = recording.fftSize
    }
    if (recording.bufferLength) {
      bufferLengthRef.current = recording.bufferLength
    }
    setIsRecording(false)
    setIsListening(false)
    setIsReplaying(true)
  }

  const handleDeleteRecording = (recordingId) => {
    setRecordings((prev) => prev.filter((r) => r.id !== recordingId))
    // If currently replaying this recording, stop replay
    if (isReplaying && recordedFramesRef.current.length) {
      const currentId = recordings.find((r) => r.frames === recordedFramesRef.current)?.id
      if (currentId === recordingId) {
        setIsReplaying(false)
      }
    }
  }

  const handleExportRecordings = () => {
    if (!recordings.length) return
    try {
      const blob = new Blob([JSON.stringify(recordings, null, 2)], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      a.href = url
      a.download = `venura-frequency-recordings-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Failed to export recordings', e)
    }
  }

  const handleImportClick = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click()
    }
  }

  const handleImportFile = (event) => {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result)
        if (!Array.isArray(parsed)) {
          // support single recording object files
          console.warn('Imported file is not an array of recordings')
          return
        }
        const imported = parsed.map((rec, idx) => {
          const createdAt = rec.createdAt || new Date().toLocaleTimeString()
          const durationMs =
            typeof rec.durationMs === 'number' && rec.durationMs > 0
              ? rec.durationMs
              : (rec.frames?.[rec.frames.length - 1]?.t ?? 0)
          return {
            id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 8)}`,
            label: rec.label || `Imported recording ${idx + 1}`,
            createdAt,
            durationMs,
            nyquistHz:
              typeof rec.nyquistHz === 'number' && rec.nyquistHz > 0
                ? rec.nyquistHz
                : nyquistRef.current,
            sampleRate:
              typeof rec.sampleRate === 'number' && rec.sampleRate > 0
                ? rec.sampleRate
                : sampleRateRef.current,
            fftSize:
              typeof rec.fftSize === 'number' && rec.fftSize > 0
                ? rec.fftSize
                : fftSizeRef.current,
            bufferLength:
              typeof rec.bufferLength === 'number' && rec.bufferLength > 0
                ? rec.bufferLength
                : bufferLengthRef.current,
            frames: Array.isArray(rec.frames) ? rec.frames : [],
          }
        })
        setRecordings((prev) => [...imported, ...prev])
      } catch (e) {
        console.error('Failed to import recordings', e)
      } finally {
        // reset input so same file can be chosen again if needed
        event.target.value = ''
      }
    }
    reader.readAsText(file)
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>Real‑Time Microphone Spectrogram</h1>
        <p>
          This visualization listens to your microphone and shows a scrolling frequency spectrum over time.
        </p>
        <p className="credit">
          Frequency analysis system developed by <strong>Venura Jayasingha</strong>, PhD Scholar, Ottawa University.
        </p>
        <p className="hint">
          If you don&apos;t see anything, check that your browser has permission to use the microphone.
        </p>
        <div className="controls">
          <button
            type="button"
            className={`primary-btn ${isRecording ? 'danger' : ''}`}
            onClick={handleToggleRecording}
          >
            {isRecording ? 'Stop Recording' : 'Start Recording'}
          </button>
          <div className="freq-box">
            <span className="freq-box-label">Freq</span>
            <span className="freq-box-value">
              {hoverFreqHz != null ? `${Math.round(hoverFreqHz)} Hz` : '—'}
            </span>
          </div>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setShowRecordings((v) => !v)}
            disabled={!recordings.length}
          >
            {!recordings.length
              ? 'View recordings (none yet)'
              : showRecordings
                ? 'Hide recordings'
                : 'View recordings'}
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleExportRecordings}
            disabled={!recordings.length}
          >
            Backup (export)
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={handleImportClick}
          >
            Import recordings
          </button>
        </div>
        <input
          type="file"
          accept="application/json"
          ref={fileInputRef}
          onChange={handleImportFile}
          style={{ display: 'none' }}
        />
        {recordings.length > 0 && showRecordings && (
          <div className="recordings">
            <h2 className="section-title">Saved recordings</h2>
            <ul>
              {recordings.map((rec) => (
                <li key={rec.id} className="recording-item">
                  <span className="recording-label">
                    {rec.label} — {Math.round(rec.durationMs / 1000)}s @ {rec.createdAt}
                  </span>
                  <div className="recording-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => handleReplay(rec.id)}
                      disabled={isReplaying}
                    >
                      Replay
                    </button>
                    <button
                      type="button"
                      className="secondary-btn danger"
                      onClick={() => handleDeleteRecording(rec.id)}
                      disabled={isReplaying}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>

      <main className="visual-sections">
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
            <h2 className="section-title" style={{ margin: 0 }}>Spectrogram (Waterfall)</h2>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', color: '#c0c0c0', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useLogScale}
                onChange={(e) => setUseLogScale(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Logarithmic Frequency Scale
            </label>
          </div>
          <div className="visual-layout">
            <div className="visual-container">
              <canvas
                ref={spectrogramRef}
                className="spectrogram-canvas"
                width={1024}
                height={320}
                onMouseMove={handleSpectrogramHover}
                onMouseLeave={() => setHoverFreqHz(null)}
              />
              {error && <div className="error">{error}</div>}
            </div>
            <aside className="frequency-scale" aria-hidden="true">
              {(() => {
                const bufferLength = bufferLengthRef.current || 1024
                const sampleRate = sampleRateRef.current || 44100
                const fftSize = fftSizeRef.current || 2048
                const canvas = spectrogramRef.current
                const height = canvas?.height || 320
                const heightMinus1 = height - 1
                
                if (heightMinus1 <= 0) {
                  // Fallback to simple linear scale if canvas not ready (5-20000 Hz range)
                  const minFreq = 5
                  const maxFreq = 20000
                  return [
                    1, 0.75, 0.5, 0.35, 0.2, 0,
                  ].map((p) => {
                    const freq = minFreq + (maxFreq - minFreq) * (1 - p)
                    const label = freq >= 1000 ? `${Math.round(freq / 100) / 10} kHz` : `${Math.round(freq)} Hz`
                    return (
                      <span key={p} className="frequency-label">
                        {label}
                      </span>
                    )
                  })
                }
                
                return [
                  1, // top
                  0.75,
                  0.5,
                  0.35,
                  0.2,
                  0, // bottom
                ].map((p) => {
                  // Calculate Y position: p = 1 is top, p = 0 is bottom
                  const y = p * heightMinus1
                  // Use same calculation as hover handler (maps to 5-20000 Hz range)
                  const freq = yToFreq(y, height, useLogScale)
                  const clampedFreq = Math.max(5, Math.min(20000, freq))
                  
                  let label = '5 Hz'
                  if (clampedFreq >= 1000) {
                    label = `${Math.round(clampedFreq / 100) / 10} kHz`
                  } else {
                    label = `${Math.round(clampedFreq)} Hz`
                  }
                  return (
                    <span key={p} className="frequency-label">
                      {label}
                    </span>
                  )
                })
              })()}
            </aside>
            <aside className="frequency-analysis-panel">
              <h3 className="analysis-title">Frequency Analysis</h3>
              <div className="analysis-section">
                <div className="analysis-item">
                  <span className="analysis-label">Top Resonating:</span>
                  <span className="analysis-value">
                    {topResonatingFreq != null
                      ? topResonatingFreq >= 1000
                        ? `${(topResonatingFreq / 1000).toFixed(2)} kHz`
                        : `${Math.round(topResonatingFreq)} Hz`
                      : '—'}
                  </span>
                </div>
                {harmonyInfo?.fundamental && (
                  <div className="analysis-item">
                    <span className="analysis-label">Fundamental:</span>
                    <span className="analysis-value">
                      {harmonyInfo.fundamental >= 1000
                        ? `${(harmonyInfo.fundamental / 1000).toFixed(2)} kHz`
                        : `${Math.round(harmonyInfo.fundamental)} Hz`}
                    </span>
                  </div>
                )}
                {harmonyInfo?.harmonics && harmonyInfo.harmonics.length > 0 && (
                  <div className="analysis-item">
                    <span className="analysis-label">Harmonics:</span>
                    <div className="harmonics-list">
                      {harmonyInfo.harmonics.map((h, idx) => (
                        <div key={idx} className="harmonic-item">
                          <span className="harmonic-order">{h.order}×</span>
                          <span className="harmonic-freq">
                            {h.frequency >= 1000
                              ? `${(h.frequency / 1000).toFixed(2)} kHz`
                              : `${Math.round(h.frequency)} Hz`}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </section>

        <section className="section-row">
          <div className="panel">
            <h2 className="section-title">Waveform</h2>
            <canvas
              ref={waveformRef}
              className="panel-canvas"
              width={512}
              height={160}
            />
          </div>
          <div className="panel">
            <h2 className="section-title">Spectrum (FFT)</h2>
            <canvas
              ref={spectrumRef}
              className="panel-canvas"
              width={512}
              height={160}
              onMouseMove={handleSpectrumHover}
              onMouseLeave={() => setHoverFreqHz(null)}
            />
          </div>
        </section>
      </main>
      </div>
  )
}

export default App
