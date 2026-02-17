import type { UserRound } from '../../api/types.js';
import './RoundDetailModal.css';

interface RoundDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  round: UserRound | null;
}

export const RoundDetailModal = ({ isOpen, onClose, round }: RoundDetailModalProps) => {
  if (!isOpen || !round) return null;

  const formattedTime = new Date(round.timestamp).toLocaleString();

  return (
    <div className="round-modal-overlay" onClick={onClose}>
      <div className="round-modal" onClick={(e) => e.stopPropagation()}>
        <div className="round-modal-header">
          <h2>{round.roundId}</h2>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="round-modal-body">
          <div className="round-meta">
            <span className="round-time">{formattedTime}</span>
          </div>

          <div className="round-full-text">
            <h3>用户输入</h3>
            <div className="text-content">{round.fullText || '[图片输入]'}</div>
          </div>

          {round.images && round.images.length > 0 && (
            <div className="round-images">
              <h3>附件图片</h3>
              <div className="image-grid">
                {round.images.map((image) => (
                  <div key={image.id} className="image-item">
                    <img src={image.url} alt={image.name} />
                    <span className="image-name">{image.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
