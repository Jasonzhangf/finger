import React, { useMemo } from 'react';
import type { RuntimeEvent } from '../../api/types';
import type { Loop } from '../TaskFlowCanvas/types';
import { LoopGroup } from './LoopGroup';
import './DialogTimeline.css';

interface DialogTimelineProps {
  events: RuntimeEvent[];
  loops: {
    plan: Loop[];
    design: Loop[];
    execution: Loop[];
    running?: Loop;
  };
}

export const DialogTimeline: React.FC<DialogTimelineProps> = ({
  events,
  loops,
}) => {
  const eventsByLoop = useMemo(() => {
    const grouped: Record<string, RuntimeEvent[]> = {
      unassigned: [],
    };

    const allLoops: Loop[] = [...loops.plan, ...loops.design, ...loops.execution];
    if (loops.running) allLoops.push(loops.running);

    allLoops.forEach((loop: Loop) => {
      grouped[loop.id] = [];
    });

    events.forEach(event => {
      let assigned = false;
      const eventTime = new Date(event.timestamp).getTime();
      
      for (const loop of allLoops) {
        const loopStart = new Date(loop.createdAt).getTime();
        const loopEnd = loop.completedAt ? new Date(loop.completedAt).getTime() : Date.now();
        
        if (eventTime >= loopStart && eventTime <= loopEnd) {
          grouped[loop.id].push(event);
          assigned = true;
          break;
        }
      }
      
      if (!assigned) {
        grouped.unassigned.push(event);
      }
    });

    return grouped;
  }, [events, loops]);

  const allLoopsWithGroup = useMemo(() => {
    const result: Array<Loop & { loopGroup: 'plan' | 'design' | 'execution' | 'running' }> = [];
    
    loops.plan.forEach(l => result.push({ ...l, loopGroup: 'plan' }));
    loops.design.forEach(l => result.push({ ...l, loopGroup: 'design' }));
    loops.execution.forEach(l => result.push({ ...l, loopGroup: 'execution' }));
    if (loops.running) result.push({ ...loops.running, loopGroup: 'running' });
    
    return result;
  }, [loops]);

  return (
    <div className="dialog-timeline">
      {allLoopsWithGroup.length === 0 && events.length === 0 ? (
        <div className="empty-timeline">
          <div className="empty-icon">💬</div>
          <div className="empty-text">输入任务开始对话</div>
        </div>
      ) : (
        <>
          {loops.running && (
            <LoopGroup 
              loop={{ ...loops.running, loopGroup: 'running' }} 
              events={eventsByLoop[loops.running.id] || []}
              isRunning
            />
          )}
          
          {allLoopsWithGroup
            .filter(l => l.id !== loops.running?.id)
            .reverse()
            .map(loop => (
              <LoopGroup 
                key={loop.id}
                loop={loop} 
                events={eventsByLoop[loop.id] || []}
              />
            ))}
          
          {eventsByLoop.unassigned.length > 0 && (
            <div className="unassigned-events">
              {eventsByLoop.unassigned.map(event => (
                <div key={event.id} className={`message ${event.role}`}>
                  <div className="message-avatar">
                    {event.role === 'user' ? '👤' : event.role === 'agent' ? '🤖' : 'ℹ️'}
                  </div>
                  <div className="message-content">
                    <div className="message-time">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </div>
                    <div className="message-text">{event.content}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
