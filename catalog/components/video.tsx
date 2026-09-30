import { createComponentImplementation } from "@a2ui/react/v0_9";
import { VideoApi } from "@a2ui/web_core/v0_9/basic_catalog";

export const Video = createComponentImplementation(VideoApi, ({ props }) => {
  return <video src={props.url} controls className="w-full rounded-lg" />;
});
