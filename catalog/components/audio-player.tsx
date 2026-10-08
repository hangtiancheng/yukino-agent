import { createComponentImplementation } from "@a2ui/react/v0_9";
import { AudioPlayerApi } from "@a2ui/web_core/v0_9/basic_catalog";

export const AudioPlayer = createComponentImplementation(
  AudioPlayerApi,
  ({ props }) => {
    return (
      <div className="flex flex-col gap-1">
        {props.description && (
          <span className="text-muted-foreground text-xs">
            {props.description}
          </span>
        )}
        <audio src={props.url} controls className="w-full" />
      </div>
    );
  },
);
