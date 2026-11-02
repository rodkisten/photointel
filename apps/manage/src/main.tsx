import React from "react";
import {createRoot} from "react-dom/client";
import {QueryClient,QueryClientProvider} from "@tanstack/react-query";
import App from "./App";

const queryClient=new QueryClient({defaultOptions:{queries:{
  staleTime:12000,retry:1,refetchOnWindowFocus:false,
}}});
const element=document.getElementById("root");
if(!element)throw new Error("Missing manage root");
createRoot(element).render(<React.StrictMode>
  <QueryClientProvider client={queryClient}><App/></QueryClientProvider>
</React.StrictMode>);
