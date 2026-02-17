import React from 'react';
import './ResourcePoolPanel.css';

interface Resource {
  id: string;
  name: string;
  type: string;
  status: string;
}

interface ResourcePoolPanelProps {
  availableResources: Resource[];
  deployedResources: Resource[];
  onDeploy?: (resourceId: string) => void;
  onRelease?: (resourceId: string) => void;
  hidden?: boolean;
}

export const ResourcePoolPanel: React.FC<ResourcePoolPanelProps> = ({
  availableResources,
  deployedResources,
  onDeploy,
  onRelease,
  hidden,
}) => {
  if (hidden) return null;

  return (
    <div className="resource-pool-panel">
      <div className="resource-pool-header">
        <h3>资源池</h3>
        <div className="resource-counts">
          <span>可用: {availableResources.length}</span>
          <span>已部署: {deployedResources.length}</span>
        </div>
      </div>

      <div className="resource-section">
        <h4>可用资源</h4>
        {availableResources.length === 0 ? (
          <div className="empty-resource">暂无可用资源</div>
        ) : (
          <div className="resource-list">
            {availableResources.map((resource) => (
              <div key={resource.id} className="resource-item available">
                <div className="resource-info">
                  <span className="resource-name">{resource.name}</span>
                  <span className="resource-type">{resource.type}</span>
                </div>
                {onDeploy && (
                  <button
                    className="resource-action deploy"
                    onClick={() => onDeploy(resource.id)}
                  >
                    部署
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="resource-section">
        <h4>已部署资源</h4>
        {deployedResources.length === 0 ? (
          <div className="empty-resource">暂无已部署资源</div>
        ) : (
          <div className="resource-list">
            {deployedResources.map((resource) => (
              <div key={resource.id} className="resource-item deployed">
                <div className="resource-info">
                  <span className="resource-name">{resource.name}</span>
                  <span className="resource-type">{resource.type}</span>
                </div>
                {onRelease && (
                  <button
                    className="resource-action release"
                    onClick={() => onRelease(resource.id)}
                  >
                    回收
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
