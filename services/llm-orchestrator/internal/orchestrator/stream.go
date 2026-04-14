package orchestrator

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// StreamMultiplexer handles multiplexing of streaming responses
type StreamMultiplexer struct {
	channels    map[string]<-chan *StreamingChunk
	output      chan *StreamingChunk
	done        chan struct{}
	wg          sync.WaitGroup
	mu          sync.Mutex
	activeCount int
}

// NewStreamMultiplexer creates a new stream multiplexer
func NewStreamMultiplexer() *StreamMultiplexer {
	return &StreamMultiplexer{
		channels: make(map[string]<-chan *StreamingChunk),
		output:   make(chan *StreamingChunk, 100),
		done:     make(chan struct{}),
	}
}

// AddSource adds a new source channel to the multiplexer
func (sm *StreamMultiplexer) AddSource(sourceID string, ch <-chan *StreamingChunk) {
	sm.mu.Lock()
	sm.channels[sourceID] = ch
	sm.activeCount++
	sm.mu.Unlock()

	sm.wg.Add(1)
	go sm.processSource(sourceID, ch)
}

// processSource processes a single source channel
func (sm *StreamMultiplexer) processSource(sourceID string, ch <-chan *StreamingChunk) {
	defer sm.wg.Done()

	for {
		select {
		case chunk, ok := <-ch:
			if !ok {
				sm.markSourceDone(sourceID)
				return
			}
			if chunk != nil {
				select {
				case sm.output <- chunk:
				case <-sm.done:
					return
				}
			}
		case <-sm.done:
			return
		}
	}
}

// markSourceDone marks a source as done
func (sm *StreamMultiplexer) markSourceDone(sourceID string) {
	sm.mu.Lock()
	sm.activeCount--
	if sm.activeCount == 0 {
		select {
		case <-sm.done:
		default:
			close(sm.done)
		}
	}
	sm.mu.Unlock()
}

// GetOutput returns the output channel
func (sm *StreamMultiplexer) GetOutput() <-chan *StreamingChunk {
	return sm.output
}

// Wait waits for all sources to complete
func (sm *StreamMultiplexer) Wait() {
	sm.wg.Wait()
	close(sm.output)
}

// Stop stops the multiplexer
func (sm *StreamMultiplexer) Stop() {
	select {
	case <-sm.done:
	default:
		close(sm.done)
	}
}

// SSEBridge converts streaming chunks to Server-Sent Events format.
// Uses a context for cancellation — when the HTTP handler exits (client
// disconnect), the context is cancelled and the goroutine exits cleanly.
type SSEBridge struct {
	chunks  <-chan *StreamingChunk
	eventCh chan string
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
}

// NewSSEBridge creates a new SSE bridge with a cancellation context.
// Callers MUST call bridge.Close() when done (typically via defer) to
// prevent goroutine leaks.
func NewSSEBridge(chunks <-chan *StreamingChunk, ctx context.Context) *SSEBridge {
	bridgeCtx, cancel := context.WithCancel(ctx)
	bridge := &SSEBridge{
		chunks:  chunks,
		eventCh: make(chan string, 10),
		ctx:     bridgeCtx,
		cancel:  cancel,
	}
	go bridge.process()
	return bridge
}

// Close cancels the bridge context, unblocking the process goroutine.
func (sb *SSEBridge) Close() {
	sb.cancel()
}

// process converts chunks to SSE format.
// Exits when the input channel closes OR the context is cancelled.
func (sb *SSEBridge) process() {
	defer close(sb.eventCh)

	for {
		select {
		case <-sb.ctx.Done():
			return
		case chunk, ok := <-sb.chunks:
			if !ok {
				return
			}
			if chunk == nil {
				continue
			}

			// Format as SSE event
			event := sb.formatSSE(chunk)
			// Send with cancellation — don't block if nobody is reading
			select {
			case sb.eventCh <- event:
			case <-sb.ctx.Done():
				return
			}
		}
	}
}

// formatSSE formats a chunk as SSE data
func (sb *SSEBridge) formatSSE(chunk *StreamingChunk) string {
	if chunk.Error != "" {
		return fmt.Sprintf("event: error\ndata: %s\n\n", chunk.Error)
	}

	if chunk.FinishReason != "" {
		return fmt.Sprintf("event: done\ndata: {\"finish_reason\": \"%s\", \"total_tokens\": %d}\n\n", chunk.FinishReason, chunk.TotalTokens)
	}

	return fmt.Sprintf("event: message\ndata: %s\n\n", chunk.Delta)
}

// Events returns a channel of SSE events
func (sb *SSEBridge) Events() <-chan string {
	return sb.eventCh
}

// FallbackStreamHandler handles fallback streaming when primary provider fails
type FallbackStreamHandler struct {
	primaryCh   <-chan *StreamingChunk
	fallbackCh  <-chan *StreamingChunk
	outputCh    chan *StreamingChunk
	switchTime  time.Time
	mu          sync.Mutex
}

// NewFallbackStreamHandler creates a new fallback stream handler
func NewFallbackStreamHandler(primaryCh, fallbackCh <-chan *StreamingChunk) *FallbackStreamHandler {
	handler := &FallbackStreamHandler{
		primaryCh:  primaryCh,
		fallbackCh: fallbackCh,
		outputCh:   make(chan *StreamingChunk, 100),
	}
	go handler.process()
	return handler
}

// process handles switching from primary to fallback
func (fsh *FallbackStreamHandler) process() {
	defer close(fsh.outputCh)

	primaryDone := false

	for {
		select {
		case chunk, ok := <-fsh.primaryCh:
			if !ok {
				primaryDone = true
				fsh.mu.Lock()
				fsh.switchTime = time.Now()
				fsh.mu.Unlock()
				// Switch to fallback
				continue
			}
			if chunk != nil {
				select {
				case fsh.outputCh <- chunk:
				default:
				}
			}

		case chunk, ok := <-fsh.fallbackCh:
			if !ok {
				return
			}
			if primaryDone && chunk != nil {
				select {
				case fsh.outputCh <- chunk:
				default:
				}
			}
		}

		if primaryDone && fsh.fallbackCh == nil {
			return
		}
	}
}

// Output returns the output channel
func (fsh *FallbackStreamHandler) Output() <-chan *StreamingChunk {
	return fsh.outputCh
}
