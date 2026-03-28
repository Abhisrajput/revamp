package queue

import (
	"fmt"
	"sync"
	"time"
)

// PriorityLevel defines priority levels
type PriorityLevel int

const (
	PriorityLow    PriorityLevel = 1
	PriorityMedium PriorityLevel = 5
	PriorityHigh   PriorityLevel = 10
)

// PriorityQueue is a thread-safe priority queue implementation
type PriorityQueue struct {
	items []*QueueItem
	mu    sync.RWMutex
}

// QueueItem represents an item in the priority queue
type QueueItem struct {
	ID        string
	Priority  int
	Data      interface{}
	EnqueuedAt time.Time
}

// NewPriorityQueue creates a new priority queue
func NewPriorityQueue() *PriorityQueue {
	return &PriorityQueue{
		items: make([]*QueueItem, 0),
	}
}

// Enqueue adds an item to the queue
func (pq *PriorityQueue) Enqueue(item *QueueItem) {
	pq.mu.Lock()
	defer pq.mu.Unlock()

	pq.items = append(pq.items, item)
	pq.heapifyUp(len(pq.items) - 1)
}

// Dequeue removes and returns the highest priority item
func (pq *PriorityQueue) Dequeue() *QueueItem {
	pq.mu.Lock()
	defer pq.mu.Unlock()

	if len(pq.items) == 0 {
		return nil
	}

	item := pq.items[0]
	pq.items[0] = pq.items[len(pq.items)-1]
	pq.items = pq.items[:len(pq.items)-1]

	if len(pq.items) > 0 {
		pq.heapifyDown(0)
	}

	return item
}

// Peek returns the highest priority item without removing it
func (pq *PriorityQueue) Peek() *QueueItem {
	pq.mu.RLock()
	defer pq.mu.RUnlock()

	if len(pq.items) == 0 {
		return nil
	}

	return pq.items[0]
}

// Size returns the number of items in the queue
func (pq *PriorityQueue) Size() int {
	pq.mu.RLock()
	defer pq.mu.RUnlock()

	return len(pq.items)
}

// IsEmpty checks if the queue is empty
func (pq *PriorityQueue) IsEmpty() bool {
	return pq.Size() == 0
}

// heapifyUp maintains heap property by moving item up
func (pq *PriorityQueue) heapifyUp(index int) {
	for index > 0 {
		parentIndex := (index - 1) / 2
		if pq.items[index].Priority > pq.items[parentIndex].Priority {
			pq.items[index], pq.items[parentIndex] = pq.items[parentIndex], pq.items[index]
			index = parentIndex
		} else {
			break
		}
	}
}

// heapifyDown maintains heap property by moving item down
func (pq *PriorityQueue) heapifyDown(index int) {
	for {
		largest := index
		left := 2*index + 1
		right := 2*index + 2

		if left < len(pq.items) && pq.items[left].Priority > pq.items[largest].Priority {
			largest = left
		}

		if right < len(pq.items) && pq.items[right].Priority > pq.items[largest].Priority {
			largest = right
		}

		if largest != index {
			pq.items[index], pq.items[largest] = pq.items[largest], pq.items[index]
			index = largest
		} else {
			break
		}
	}
}

// GetByID retrieves an item by ID
func (pq *PriorityQueue) GetByID(id string) *QueueItem {
	pq.mu.RLock()
	defer pq.mu.RUnlock()

	for _, item := range pq.items {
		if item.ID == id {
			return item
		}
	}

	return nil
}

// RemoveByID removes an item by ID
func (pq *PriorityQueue) RemoveByID(id string) bool {
	pq.mu.Lock()
	defer pq.mu.Unlock()

	for i, item := range pq.items {
		if item.ID == id {
			pq.items[i] = pq.items[len(pq.items)-1]
			pq.items = pq.items[:len(pq.items)-1]

			if i < len(pq.items) {
				pq.heapifyDown(i)
				pq.heapifyUp(i)
			}

			return true
		}
	}

	return false
}

// UpdatePriority updates the priority of an item
func (pq *PriorityQueue) UpdatePriority(id string, newPriority int) error {
	pq.mu.Lock()
	defer pq.mu.Unlock()

	var index int
	var found bool

	for i, item := range pq.items {
		if item.ID == id {
			index = i
			found = true
			break
		}
	}

	if !found {
		return fmt.Errorf("item not found: %s", id)
	}

	pq.items[index].Priority = newPriority

	// Re-heapify
	pq.heapifyDown(index)
	pq.heapifyUp(index)

	return nil
}

// GetAll returns all items in priority order
func (pq *PriorityQueue) GetAll() []*QueueItem {
	pq.mu.RLock()
	defer pq.mu.RUnlock()

	items := make([]*QueueItem, len(pq.items))
	copy(items, pq.items)
	return items
}

// Clear removes all items from the queue
func (pq *PriorityQueue) Clear() {
	pq.mu.Lock()
	defer pq.mu.Unlock()

	pq.items = make([]*QueueItem, 0)
}
